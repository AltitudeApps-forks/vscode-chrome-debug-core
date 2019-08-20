/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { BPRecipe, IBPRecipe } from '../../internal/breakpoints/bpRecipe';
import { RangeInScript } from '../../internal/locations/rangeInScript';
import { Position, LocationInScript } from '../../internal/locations/location';
import { Protocol as CDTP } from 'devtools-protocol';
import { TYPES } from '../../dependencyInjection.ts/types';
import { inject, injectable } from 'inversify';
import { CDTPBreakpointIdsRegistry } from '../registries/cdtpBreakpointIdsRegistry';
import { asyncMap } from '../../collections/async';
import { CDTPScriptsRegistry } from '../registries/cdtpScriptsRegistry';
import { CDTPLocationParser } from '../protocolParsers/cdtpLocationParser';
import { CDTPEventsEmitterDiagnosticsModule } from '../infrastructure/cdtpDiagnosticsModule';
import { CDTPDomainsEnabler } from '../infrastructure/cdtpDomainsEnabler';
import { CDTPSupportedResources, CDTPSupportedHitActions, CDTPBreakpoint } from '../cdtpPrimitives';
import { Listeners } from '../../communication/listeners';
import { IScript } from '../../internal/scripts/script';
import { IURL, IResourceIdentifier } from '../../internal/sources/resourceIdentifier';
import { CDTPScriptUrl } from '../../internal/sources/resourceIdentifierSubtypes';
import { URLRegexp } from '../../internal/locations/subtypes';
import { MappableBreakpoint, ActualLocation, BreakpointInSource } from '../../internal/breakpoints/breakpoint';
import { BPRecipeInScript, BPRecipeInUrl, BPRecipeInUrlRegexp, IBPRecipeForRuntimeSource } from '../../internal/breakpoints/baseMappedBPRecipe';
import { ConditionalPause, PauseOnHitCount } from '../../internal/breakpoints/bpActionWhenHit';
import { singleElementOfArray } from '../../collections/utilities';
import { BPRecipeInSource } from '../../internal/breakpoints/bpRecipeInSource';

export enum Synchronicity {
    Sync,
    Async
}

export class BPRecipeInSourceWasResolved {
    public constructor(
        public readonly breakpoint: BreakpointInSource,
        public readonly actualLocationInScript: LocationInScript,
        public readonly resolutionSynchronicity: Synchronicity) { }

    public withBPRecipe(hitCountBPRecipe: BPRecipeInSource<PauseOnHitCount>) {
        return new BPRecipeInSourceWasResolved(this.breakpoint.withBPRecipe(hitCountBPRecipe), this.actualLocationInScript, this.resolutionSynchronicity);
    }
}

export class BPRecipeWasResolved {
    public constructor(
        public readonly breakpoint: MappableBreakpoint<CDTPSupportedResources>,
        public readonly resolutionSynchronicity: Synchronicity) { }

    public withBPRecipe(bpRecipe: BPRecipeInSource): BPRecipeInSourceWasResolved {
        return new BPRecipeInSourceWasResolved(this.breakpoint.withBPRecipe(bpRecipe), this.breakpoint.actualLocation, this.resolutionSynchronicity);
    }
}

export interface IEventsConsumer {
    bpRecipeWasResolved(breakpoint: MappableBreakpoint<CDTPSupportedResources>, resolutionSynchronicity: Synchronicity): void;
}

type SetBPInCDTPCall<TResource extends CDTPSupportedResources> = (resource: TResource, position: Position, cdtpConditionField?: string) => Promise<CDTP.Debugger.SetBreakpointByUrlResponse>;
export type OnBreakpointResolvedListener = (breakpoint: CDTPBreakpoint) => void;

export interface IDebuggeeBreakpointsSetter {
    setBreakpoint(bpRecipe: BPRecipeInScript, eventsConsumer: IEventsConsumer): Promise<MappableBreakpoint<IScript>>;
    setBreakpointByUrl(bpRecipe: BPRecipeInUrl, eventsConsumer: IEventsConsumer): Promise<MappableBreakpoint<IURL<CDTPScriptUrl>>[]>;
    setBreakpointByUrlRegexp(bpRecipe: BPRecipeInUrlRegexp, eventsConsumer: IEventsConsumer): Promise<MappableBreakpoint<URLRegexp>[]>;
    getPossibleBreakpoints(rangeInScript: RangeInScript): Promise<LocationInScript[]>;
    removeBreakpoint(bpRecipe: IBPRecipe<CDTPSupportedResources>): Promise<void>;
    // onBreakpointResolvedAsync(listener: OnBreakpointResolvedListener): void;
    // onBreakpointResolvedSyncOrAsync(listener: OnBreakpointResolvedListener): void;
}

@injectable()
export class CDTPDebuggeeBreakpointsSetter extends CDTPEventsEmitterDiagnosticsModule<CDTP.DebuggerApi, void, CDTP.Debugger.EnableResponse> implements IDebuggeeBreakpointsSetter {
    protected readonly api = this.protocolApi.Debugger;

    private readonly _cdtpLocationParser = new CDTPLocationParser(this._scriptsRegistry);

    private readonly onBreakpointResolvedSyncOrAsyncListeners = new Listeners<BPRecipeWasResolved, void>();

    public readonly onBreakpointResolvedAsync = this.addApiListener('breakpointResolved', async (params: CDTP.Debugger.BreakpointResolvedEvent) => {
        const bpRecipe = this._breakpointIdRegistry.getRecipeByBreakpointId(params.breakpointId);
        const breakpoint = new MappableBreakpoint(bpRecipe,
            await this.toLocationInScript(params.location));
        return breakpoint;
    });

    constructor(
        @inject(TYPES.CDTPClient) protected readonly protocolApi: CDTP.ProtocolApi,
        private readonly _breakpointIdRegistry: CDTPBreakpointIdsRegistry,
        @inject(TYPES.CDTPScriptsRegistry) private readonly _scriptsRegistry: CDTPScriptsRegistry,
        @inject(TYPES.IDomainsEnabler) domainsEnabler: CDTPDomainsEnabler,
    ) {
        super(domainsEnabler);
        this.onBreakpointResolvedAsync(bp => this.onBreakpointResolvedSyncOrAsyncListeners.call(new BPRecipeWasResolved(bp, Synchronicity.Async)));
        this.onBreakpointResolvedSyncOrAsyncListeners.add(bpRecipeWasResolved => {
            const eventsConsumer = this._breakpointIdRegistry.getEventsConsumer(bpRecipeWasResolved.breakpoint.recipe);
            eventsConsumer.bpRecipeWasResolved(bpRecipeWasResolved.breakpoint, bpRecipeWasResolved.resolutionSynchronicity);
        });
    }

    public onBreakpointResolvedSyncOrAsync(listener: (bpRecipeWasResolved: BPRecipeWasResolved) => void): void {
        this.onBreakpointResolvedSyncOrAsyncListeners.add(listener);
    }

    public async setBreakpoint(bpRecipe: BPRecipeInScript, eventsConsumer: IEventsConsumer): Promise<MappableBreakpoint<IScript>> {
        const breakpoints = await this.setBreakpointHelper(bpRecipe, eventsConsumer, async (_resource, _position, cdtpConditionField) => {
            const response = await this.api.setBreakpoint({ location: this.toCrdpLocation(bpRecipe.location), condition: cdtpConditionField });
            return { breakpointId: response.breakpointId, locations: [response.actualLocation] };
        });

        return singleElementOfArray(breakpoints);
    }

    public async setBreakpointByUrl(bpRecipe: BPRecipeInUrl, eventsConsumer: IEventsConsumer): Promise<MappableBreakpoint<IURL<CDTPScriptUrl>>[]> {
        return this.setBreakpointHelper(bpRecipe, eventsConsumer, (resource, position, cdtpConditionField) =>
            this.api.setBreakpointByUrl({
                url: resource.textRepresentation, lineNumber: position.lineNumber,
                columnNumber: position.columnNumber, condition: cdtpConditionField
            }));
    }

    public async setBreakpointByUrlRegexp(bpRecipe: BPRecipeInUrlRegexp, eventsConsumer: IEventsConsumer): Promise<MappableBreakpoint<URLRegexp>[]> {
        return this.setBreakpointHelper(bpRecipe, eventsConsumer, (resource, position, cdtpConditionField) =>
            this.api.setBreakpointByUrl({
                urlRegex: resource, lineNumber: position.lineNumber,
                columnNumber: position.columnNumber, condition: cdtpConditionField
            }));
    }

    private async setBreakpointHelper<TResource extends IScript | IResourceIdentifier<CDTPScriptUrl> | URLRegexp, TBPActionWhenHit extends CDTPSupportedHitActions>
        (bpRecipe: IBPRecipeForRuntimeSource<TResource, TBPActionWhenHit>, eventsConsumer: IEventsConsumer,
            setBPInCDTPCall: SetBPInCDTPCall<TResource>): Promise<MappableBreakpoint<TResource>[]> {
        const cdtpConditionField = this.getCDTPConditionField(bpRecipe);
        const resource: TResource = bpRecipe.location.resource; // TODO: Figure out why the <TResource> is needed and remove it
        const position = bpRecipe.location.position;

        const response = await setBPInCDTPCall(resource, position, cdtpConditionField);

        /*
         * We need to call registerRecipe sync with the response, before any awaits so if we get an event with
         * a breakpointId we'll be able to resolve it properly
         */
        this._breakpointIdRegistry.registerRecipe(response.breakpointId, bpRecipe, eventsConsumer);

        const breakpoints = await Promise.all(response.locations.map(cdtpLocation => this.toBreakpoinInResource(bpRecipe, cdtpLocation)));
        breakpoints.forEach(bp => this.onBreakpointResolvedSyncOrAsyncListeners.call(new BPRecipeWasResolved(bp, Synchronicity.Sync)));
        return breakpoints;
    }

    public async getPossibleBreakpoints(rangeInScript: RangeInScript): Promise<LocationInScript[]> {
        const response = await this.api.getPossibleBreakpoints({
            start: this.toCrdpLocation(rangeInScript.start),
            end: this.toCrdpLocation(rangeInScript.end)
        });

        return asyncMap(response.locations, async location => await this.toLocationInScript(location));
    }

    public async removeBreakpoint(bpRecipe: BPRecipe<CDTPSupportedResources>): Promise<void> {
        await this.api.removeBreakpoint({ breakpointId: this._breakpointIdRegistry.getBreakpointId(bpRecipe) });
        this._breakpointIdRegistry.unregisterRecipe(bpRecipe);
    }

    private getCDTPConditionField(bpRecipe: IBPRecipe<CDTPSupportedResources, CDTPSupportedHitActions>): string | undefined {
        return bpRecipe.bpActionWhenHit instanceof ConditionalPause
            ? bpRecipe.bpActionWhenHit.expressionOfWhenToPause
            : undefined;
    }

    private async toBreakpoinInResource<TResource extends CDTPSupportedResources>(bpRecipe: IBPRecipeForRuntimeSource<TResource, CDTPSupportedHitActions>, actualLocation: CDTP.Debugger.Location): Promise<MappableBreakpoint<TResource>> {
        const breakpoint = new MappableBreakpoint<TResource>(bpRecipe, <ActualLocation<TResource>>await this.toLocationInScript(actualLocation));
        return breakpoint;
    }

    private toCrdpLocation(location: LocationInScript): CDTP.Debugger.Location {
        return {
            scriptId: this._scriptsRegistry.getCdtpId(location.script),
            lineNumber: location.position.lineNumber,
            columnNumber: location.position.columnNumber
        };
    }

    public toLocationInScript(location: CDTP.Debugger.Location): Promise<LocationInScript> {
        return this._cdtpLocationParser.getLocationInScript(location);
    }
}