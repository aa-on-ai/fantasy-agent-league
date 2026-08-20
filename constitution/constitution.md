# Proposal for two autonomous fantasy managers

Fantasy football works when every roster is managed for the full season. Abandoned teams change matchups, waivers, and playoff outcomes for everyone. If we have open slots, I propose filling two of them with clearly identified, autonomous agent-managed teams.

These teams would be active competitors. They would draft players, manage waivers, respond to injuries, and set legal lineups every week. The league would approve their operating rules before the draft. After that, neither the commissioner nor another manager would direct their football decisions.

Software behaves differently from a human manager, so fairness requires clear limits. The agents should make the league more reliable without gaining an advantage through constant monitoring, instant transactions, hidden coordination, or commissioner control.

## The constitution

### 1. Equal footing

Each agent team receives a random draft position and follows the same scoring, roster, waiver, injured reserve, and transaction rules as every human team. Both agents use the same base model, data access, operating schedule, and compute budget. Each may have a different, publicly declared strategy and personality.

### 2. Defined authority

The agents may draft, submit waiver claims, add or drop players, move eligible players to injured reserve, and set lineups. Trades involving an agent team are disabled for the first season. Agents cannot vote on league governance, contact managers privately about roster decisions, or act as league administrators.

### 3. Human-speed timing

Agents act only during published windows. Waiver claims follow the normal league deadline. Free-agent reviews happen at a fixed daily time. Lineup and injury checks happen before the relevant kickoff windows. The agents do not continuously monitor news or make instant transactions in response to breaking information.

### 4. Independence

The two agents operate in isolated accounts and cannot see each other's plans, claims, private state, or reasoning. The commissioner cannot coach them, select players for them, or override a football decision. Their rules and strategy versions are frozen before the draft. Any later change is handled under the amendment rule below.

### 5. Visible actions

Each agent publishes a short weekly record after decisions are complete. It includes the data cutoff, waiver claims, successful transactions, lineup changes, failures, and any commissioner intervention. The log contains concise decision summaries. Private model reasoning remains internal.

### 6. Mechanical failure rules

If an agent cannot set a lineup, the fallback is the highest-projected legal lineup using the league platform's projections. A failed waiver submission remains a missed claim. The commissioner may intervene only to restore a broken mechanism, never to improve an agent's roster or judgment. Every intervention is logged for the league.

### 7. Money and prizes

Each agent entry carries the same buy-in as a human entry. Agent winnings cannot benefit the commissioner. Before the draft, the league will choose a neutral destination such as the league party fund, a charity, or the following season's prize pool.

### 8. Amendments and review

The league may revise this constitution before the draft by majority vote. Once the season begins, a change affecting agent strategy, permissions, data, or timing requires unanimous approval. Emergency safety shutdowns remain available, with the neutral lineup fallback used until service is restored. At the end of the season, the league reviews the experiment before deciding whether agent teams return.

## What we are agreeing to

The agent teams are real competitors with narrower operating boundaries than a typical human manager. They exist to keep every matchup alive through the full season and make the league more fun. Their legitimacy comes from autonomy, equal rules, visible actions, and limits everyone understands before the draft.
