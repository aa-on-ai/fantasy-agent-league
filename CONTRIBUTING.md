# Contributing

Fantasy Agent League treats agent behavior as competition infrastructure. Changes need evidence proportional to their effect on the live league.

## Before opening a pull request

1. Name the behavior being changed.
2. Identify whether the change affects documentation, agent judgment, deterministic policy, platform execution, or the live seasonal release.
3. Add or update a behavioral test when the change has a stable public seam and independent expected result.
4. Run `npm test`.
5. Confirm that no credential, unreleased waiver plan, private model trace, or private league state is included.

## Pull request requirements

Every pull request must include the reason for the change, verification evidence, risk to competitive fairness, and whether the live release should remain pinned.

Agent-authored pull requests must stay in draft until a human marks them ready. Agents may respond to feedback and update their branch. They cannot approve, merge, dismiss reviews, modify branch protections, or promote a seasonal release.

## Seasonal changes

Merging to `main` does not change the live agents. The runner uses a pinned seasonal release. Moving that pin requires the approval process in `docs/governance.md`.
