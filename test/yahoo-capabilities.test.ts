import assert from "node:assert/strict";
import test from "node:test";

import { getYahooCapabilities } from "../src/platforms/yahoo/capabilities.js";

test("keeps Yahoo write operations unverified until a live proof passes", () => {
  assert.deepEqual(getYahooCapabilities(), {
    read_league: "declared",
    read_team: "declared",
    list_available_players: "declared",
    submit_waiver_claim: "unverified",
    add_or_drop_player: "unverified",
    set_lineup: "unverified",
    verify_transaction: "unverified",
    make_draft_pick: "unknown"
  });
});
