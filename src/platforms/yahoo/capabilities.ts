import type { PlatformCapabilities } from "../contracts.js";

export function getYahooCapabilities(): PlatformCapabilities {
  return {
    read_league: "declared",
    read_team: "declared",
    list_available_players: "declared",
    submit_waiver_claim: "unverified",
    add_or_drop_player: "unverified",
    set_lineup: "unverified",
    verify_transaction: "unverified",
    make_draft_pick: "unknown"
  };
}
