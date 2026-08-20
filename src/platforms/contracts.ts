export type CapabilityStatus = "declared" | "verified" | "unverified" | "unknown";

export type PlatformOperation =
  | "read_league"
  | "read_team"
  | "list_available_players"
  | "submit_waiver_claim"
  | "add_or_drop_player"
  | "set_lineup"
  | "verify_transaction"
  | "make_draft_pick";

export type PlatformCapabilities = Readonly<Record<PlatformOperation, CapabilityStatus>>;
