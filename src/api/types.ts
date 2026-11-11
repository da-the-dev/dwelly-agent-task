// Friendly names over the generated spec types. Do not hand-edit schema.d.ts:
// regenerate it with `npm run gen:types` after `npm run fetch:spec`.
import type { components } from "./schema.js";

type S = components["schemas"];

export type WorldEvent = S["Event"];
export type EventsResponse = S["EventsResponse"];
export type Contractor = S["Contractor"];
export type Case = S["Case"];
export type CaseCreate = S["CaseCreate"];
export type CasePatch = S["CasePatch"];
export type WorkOrder = S["WorkOrder"];
export type WorkOrderCreate = S["WorkOrderCreate"];
export type WorkOrderUpdate = S["WorkOrderUpdate"];
export type ActorMessage = S["ActorMessage"];
export type ApiError = S["Error"];
export type HistoryCase = S["HistoryCase"];
export type HistoryCasesResponse = S["HistoryCasesResponse"];

export type Urgency = NonNullable<Case["urgency"]>;
