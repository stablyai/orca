# PR #11203 fresh final-verifier findings

## Reproduction verifier

Verdict: changes requested on `5bc3797d024e956196f77a59764297ec6a52a029`.

A creator pane retained a Run A Dispatch under handle H-old, was recreated with a new PTY/process
incarnation and handle H-new on the same stable leaf, and then became the coordinator of Run B. The
nested Run A worker still published the creator parent because the candidate proved creator
authority from the retained H-old Dispatch row. The required boundary is the owning runtime's
current pane, exact process incarnation, and Run consumer generation; a terminal handle alone is
historical routing metadata.

## Architecture and performance verifier

Verdict: changes requested on `5bc3797d024e956196f77a59764297ec6a52a029`.

The creator-remint trace reproduced the same stale Run A edge. Independently, the candidate's
creator-conflict SQL searched retained Runs by the unindexed `coordinator_handle`: 300 lookups with
20,000 Runs took 232.7 ms, versus 7.9 ms after indexing the lookup. A second retained-Run scale
measurement observed 2.0272 ms per Task read with 50,000 Runs on a graph-publication path whose
budget is 16 ms.

## Required correction

- Capture creator pane, process incarnation, and owning Run generation at Task creation.
- Revalidate those values against authoritative current pane ownership before publishing lineage.
- Remove the retained-Run conflict scan or replace it with an indexed/bounded lookup.
- Preserve the six established authority oracles and the 201/200 public method-call boundary.
- Add the real H-old to H-new Run A/Run B regression plus query-plan and retained-Run scaling tests.

The coordinator supplied these final findings for local preservation; the verifier workspaces did
not modify this PR workspace.
