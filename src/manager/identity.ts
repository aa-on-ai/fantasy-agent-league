import { mkdir, lstat, open, readdir } from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolute, join, parse, resolve, sep } from "node:path";
import { digest } from "./season.js";

export interface ManagerScope { platform: "yahoo"; leagueId: string; teamId: string }
export const DEFAULT_MANAGER_SCOPE: Readonly<ManagerScope> = Object.freeze({ platform: "yahoo", leagueId: "425299", teamId: "11" });
export interface ManagerIdentity {
  schemaVersion: 1;
  revision: 1;
  id: string;
  scope: ManagerScope;
  createdAt: string;
  strategy: "steady";
  // Display names can evolve without changing the account/team identity.
  displayName: null;
  character: {
    version: 1;
    status: "owner_directed";
    origin: string;
    development: string;
    provenance: { reference: string; ownerMessageId: string; capturedAt: string };
  };
  expression: { writingFormat: "first_person_personal_account"; publication: "review_required"; avatar: "approval_required" };
  hash: string;
}

export function managerIdentityId(scope: ManagerScope): string {
  if (!scope || scope.platform !== "yahoo" || !/^[1-9]\d*$/.test(scope.leagueId) || !/^[1-9]\d*$/.test(scope.teamId))
    throw new Error("invalid_manager_identity_scope");
  return `yahoo:f1:${scope.leagueId}:team:${scope.teamId}`;
}
export function managerIdentityHash(identity: Omit<ManagerIdentity, "hash">): string {
  const { hash: _, ...body } = identity as ManagerIdentity;
  return digest(body);
}
export function validateManagerIdentity(value: unknown, scope: ManagerScope): ManagerIdentity {
  const identity = value as ManagerIdentity;
  if (!identity || identity.schemaVersion !== 1 || identity.revision !== 1 || identity.strategy !== "steady" ||
      identity.displayName !== null || identity.character?.version !== 1 || identity.character.status !== "owner_directed" ||
      typeof identity.character.origin !== "string" || !identity.character.origin.trim() || identity.character.origin.length > 2000 ||
      typeof identity.character.development !== "string" || !identity.character.development.trim() || identity.character.development.length > 2000 ||
      identity.character.provenance?.reference !== "gbrain:projects/fantasy-football-agent" ||
      identity.character.provenance.ownerMessageId !== "1549548750781812737" ||
      !Number.isFinite(Date.parse(identity.character.provenance.capturedAt)) ||
      identity.expression?.writingFormat !== "first_person_personal_account" || identity.expression.publication !== "review_required" ||
      identity.expression.avatar !== "approval_required" || !Number.isFinite(Date.parse(identity.createdAt)))
    throw new Error("invalid_manager_identity");
  if (identity.id !== managerIdentityId(scope) || identity.id !== managerIdentityId(identity.scope))
    throw new Error("manager_identity_scope_mismatch");
  if (identity.hash !== managerIdentityHash(identity)) throw new Error("manager_identity_hash_mismatch");
  return identity;
}

// Check existing path components before mkdir so no secret state can be created
// through an ancestor symlink. Ancestor permissions are host-owned; our own
// directory and every data file must be private. Do not chmod shared parents.
export async function privateMemoryDirectory(directory: string, create = false): Promise<void> {
  if (!isAbsolute(directory)) throw new Error("unsafe_manager_memory_path");
  const target = resolve(directory), root = parse(target).root;
  if (target === root) throw new Error("unsafe_manager_memory_path");
  let cursor = root;
  for (const part of target.slice(root.length).split(sep)) {
    cursor = join(cursor, part);
    try {
      const info = await lstat(cursor);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("unsafe_manager_memory_path");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (!create) throw error;
      try { await mkdir(cursor, { mode: 0o700 }); }
      catch (mkdirError) { if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") throw mkdirError; }
      const created = await lstat(cursor);
      if (created.isSymbolicLink() || !created.isDirectory()) throw new Error("unsafe_manager_memory_path");
    }
  }
  if (((await lstat(target)).mode & 0o077) !== 0) throw new Error("manager_memory_permissions_not_private");
}
export async function readPrivateMemoryJson(path: string): Promise<unknown> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o077) !== 0 || info.size > 1024 * 1024)
      throw new Error("unsafe_manager_memory_file");
    return JSON.parse(await file.readFile("utf8"));
  } finally { await file.close(); }
}
export async function createPrivateMemoryJson(directory: string, name: string, value: unknown): Promise<void> {
  if (!/^[a-z0-9.-]+\.json$/.test(name)) throw new Error("unsafe_manager_memory_path");
  const file = await open(join(directory, name), "wx", 0o600);
  try { await file.writeFile(JSON.stringify(value) + "\n", "utf8"); await file.sync(); }
  finally { await file.close(); }
  const parent = await open(directory, "r");
  try { await parent.sync(); } finally { await parent.close(); }
}

export async function loadManagerIdentity(directory: string, scope: ManagerScope = DEFAULT_MANAGER_SCOPE): Promise<ManagerIdentity | null> {
  managerIdentityId(scope);
  try {
    await privateMemoryDirectory(directory);
    return structuredClone(validateManagerIdentity(await readPrivateMemoryJson(join(directory, "identity.json")), scope));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      // Missing identity must not silently adopt orphaned history.
      try { if ((await readdir(directory)).length) throw new Error("manager_identity_missing_with_existing_state"); }
      catch (scanError) { if ((scanError as NodeJS.ErrnoException).code !== "ENOENT") throw scanError; }
      return null;
    }
    throw error;
  }
}

export async function loadOrCreateManagerIdentity(directory: string, scope: ManagerScope = DEFAULT_MANAGER_SCOPE, now = new Date()): Promise<ManagerIdentity> {
  const existing = await loadManagerIdentity(directory, scope);
  if (existing) return existing;
  const identity: ManagerIdentity = { schemaVersion: 1, revision: 1, id: managerIdentityId(scope), scope: structuredClone(scope),
    createdAt: now.toISOString(), strategy: "steady", displayName: null,
    character: { version: 1, status: "owner_directed",
      origin: "Dropped into an unfamiliar world and suddenly expected to compete in a chaotic fantasy football league. Discover the world through actual experience; do not pretend football knowledge is unavailable.",
      development: "Allow disorientation, curiosity, vulnerability, social discovery and emerging competitive stakes. Do not predetermine jokes, emotions, rivalries, lessons or a redemption arc. Character reactions are authored expression, not verified subjective experience.",
      provenance: { reference: "gbrain:projects/fantasy-football-agent", ownerMessageId: "1549548750781812737", capturedAt: "2026-09-15T22:34:58.176Z" } },
    expression: { writingFormat: "first_person_personal_account", publication: "review_required", avatar: "approval_required" }, hash: "" };
  identity.hash = managerIdentityHash(identity);
  validateManagerIdentity(identity, scope);
  await privateMemoryDirectory(directory, true);
  try { await createPrivateMemoryJson(directory, "identity.json", identity); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const stored = await loadManagerIdentity(directory, scope);
  if (!stored) throw new Error("manager_identity_write_unverified");
  return stored;
}
