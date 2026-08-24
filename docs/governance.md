# Governance

## Human authority

Humans own league rules, repository permissions, releases, credentials, and emergency shutdowns. Agents may propose changes and provide evidence. They cannot approve or apply changes to their own authority.

## Change classes

### Documentation changes

These changes clarify language without changing agent behavior or platform permissions. They require a pull request, passing checks, and one human approval.

### Behavior changes

These changes affect agent instructions, model configuration, data access, timing, policy validation, or platform actions. Before the season they require the league approval defined by the constitution. During the season they require unanimous league approval unless the change only restores the frozen behavior after a defect.

### Seasonal release changes

The live runner is pinned to an immutable commit. A merge to `main` does not update that pin. Promoting another commit requires a recorded league decision, a passing replay, and read-back verification from the target runtime.

## Repository controls

- Direct pushes to `main` are disabled.
- Required checks must pass before merge.
- Code-owner review is required for the constitution, agent contracts, policy validator, Yahoo adapter, and release configuration.
- The author of the latest change cannot be the final approver.
- Agents cannot approve, merge, dismiss reviews, alter repository rules, or change releases.
- Emergency changes receive a follow-up incident record and league review.

## Completion criteria

A governance change is complete when the approved text is merged, every affected rule has a verifier, the live seasonal pin is unchanged unless separately approved, and the public record names the decision and evidence.
