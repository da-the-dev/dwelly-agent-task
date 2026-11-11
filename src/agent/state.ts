// The case's state is three fields, set by code from the classifier's next_step (the model
// never sets them). status uses Dwelly's own Case.status values so rung 3 can PATCH it.
import type { CaseStatus, NextStep, Outcome, WaitingOn } from "../case.js";

export interface CaseState {
  status: CaseStatus;
  waitingOn: WaitingOn;
  outcome: Outcome | null;
}

const BY_NEXT_STEP: Record<NextStep, CaseState> = {
  // We asked the tenant something; their reply moves the case.
  need_info: { status: "open", waitingOn: "tenant", outcome: null },
  // Rung 4 picks a contractor and raises a work order.
  contractor: { status: "open", waitingOn: "contractor", outcome: null },
  // The tenant can fix it with guidance; close once they confirm (archive 14).
  self_help: { status: "open", waitingOn: "tenant", outcome: null },
  // Someone else's emergency line owns it (gas network, archive 05); we follow up.
  external: { status: "in_progress", waitingOn: "external", outcome: null },
  // Cosmetic: logged against the property, no callout (archive 03).
  log_only: { status: "closed", waitingOn: "none", outcome: "logged" },
  // Nothing to repair (archive 11).
  out_of_scope: { status: "closed", waitingOn: "none", outcome: "out_of_scope" },
};

export function stateFor(nextStep: NextStep): CaseState {
  return { ...BY_NEXT_STEP[nextStep] };
}
