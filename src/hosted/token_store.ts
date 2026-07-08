import { mkdir, readFile, rename, writeFile } from "fs/promises"
import { dirname } from "path"
import { defaultAccessPolicy, normalizePolicy, type AccessMode, type TargetprocessAccessPolicy } from "./policy.js"
import { decryptSecret, encryptSecret, type EncryptedValue } from "./security.js"

export type TargetprocessCredential =
  | { kind: "targetprocess_access_token"; token: string }
  | { kind: "targetprocess_shared_token" }

export type TargetprocessUserSettings = {
  accessMode: AccessMode
  policy: TargetprocessAccessPolicy
}

export type TargetprocessAccount = TargetprocessUserSettings & {
  credential: TargetprocessCredential | null
  email?: string
  updatedAt?: string
}

export type StoredTargetprocessToken = {
  userId: string
  email: string
  encryptedToken: EncryptedValue
  updatedAt: string
}

export type StoredTargetprocessCredential = {
  userId: string
  email: string
  kind: string
  encryptedToken?: EncryptedValue
  accessMode?: AccessMode
  policy?: Partial<TargetprocessAccessPolicy>
  updatedAt: string
}

export interface TargetprocessCredentialStore {
  getCredential(userId: string): Promise<TargetprocessCredential | null>
  setCredential(userId: string, email: string, credential: TargetprocessCredential): Promise<void>
  deleteCredential(userId: string): Promise<void>
  hasCredential(userId: string): Promise<boolean>
  getAccount(userId: string): Promise<TargetprocessAccount | null>
  setAccount(userId: string, email: string, account: TargetprocessAccount): Promise<void>
  setSettings(userId: string, email: string, settings: TargetprocessUserSettings): Promise<void>
}

type LegacyStoreFile = {
  version: 1
  users: Record<string, StoredTargetprocessToken>
}

type StoreFile = {
  version: 2 | 3
  users: Record<string, StoredTargetprocessCredential>
}

export class EncryptedFileCredentialStore implements TargetprocessCredentialStore {
  constructor(
    private readonly path: string,
    private readonly encryptionKey: Buffer,
  ) {}

  async getCredential(userId: string): Promise<TargetprocessCredential | null> {
    const entry = (await this.readStore()).users[userId]
    return credentialFromEntry(entry, this.encryptionKey)
  }

  async getAccount(userId: string): Promise<TargetprocessAccount | null> {
    const entry = (await this.readStore()).users[userId]
    if (!entry) return null
    return {
      credential: credentialFromEntry(entry, this.encryptionKey),
      accessMode: entry.accessMode || (entry.kind === "targetprocess_shared_token" ? "shared" : "personal"),
      policy: normalizePolicy(entry.policy),
      email: entry.email,
      updatedAt: entry.updatedAt,
    }
  }

  async setCredential(userId: string, email: string, credential: TargetprocessCredential): Promise<void> {
    const account = await this.getAccount(userId) || defaultAccount()
    await this.setAccount(userId, email, {
      credential,
      accessMode: credential.kind === "targetprocess_shared_token" ? "shared" : "personal",
      policy: account.policy,
    })
  }

  async setAccount(userId: string, email: string, account: TargetprocessAccount): Promise<void> {
    const store = await this.readStore()
    const base = {
      userId,
      email,
      kind: account.credential?.kind || (account.accessMode === "shared" ? "targetprocess_shared_token" : "targetprocess_access_token"),
      accessMode: account.accessMode,
      policy: normalizePolicy(account.policy),
      updatedAt: new Date().toISOString(),
    }
    store.users[userId] = account.credential?.kind === "targetprocess_access_token"
      ? { ...base, encryptedToken: encryptSecret(account.credential.token, this.encryptionKey) }
      : base
    await this.writeStore(store)
  }

  async setSettings(userId: string, email: string, settings: TargetprocessUserSettings): Promise<void> {
    const account = await this.getAccount(userId) || defaultAccount()
    await this.setAccount(userId, email, {
      ...account,
      accessMode: settings.accessMode,
      policy: settings.policy,
    })
  }

  async deleteCredential(userId: string): Promise<void> {
    const store = await this.readStore()
    delete store.users[userId]
    await this.writeStore(store)
  }

  async hasCredential(userId: string): Promise<boolean> {
    const store = await this.readStore()
    return Boolean(store.users[userId])
  }

  async getToken(userId: string): Promise<string | null> {
    const credential = await this.getCredential(userId)
    return credential?.kind === "targetprocess_access_token" ? credential.token : null
  }

  async setToken(userId: string, email: string, token: string): Promise<void> {
    await this.setCredential(userId, email, { kind: "targetprocess_access_token", token })
  }

  async deleteToken(userId: string): Promise<void> {
    await this.deleteCredential(userId)
  }

  async hasToken(userId: string): Promise<boolean> {
    return this.hasCredential(userId)
  }

  private async readStore(): Promise<StoreFile> {
    try {
      const raw = await readFile(this.path, "utf8")
      const parsed = JSON.parse(raw) as StoreFile | LegacyStoreFile
      if (parsed.version === 1 && typeof parsed.users === "object" && parsed.users !== null) {
        return migrateLegacyStore(parsed)
      }
      if ((parsed.version !== 2 && parsed.version !== 3) || typeof parsed.users !== "object" || parsed.users === null) {
        throw new Error("Unsupported token store format")
      }
      return parsed
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { version: 3, users: {} }
      }
      throw error
    }
  }

  private async writeStore(store: StoreFile): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
    const tempPath = `${this.path}.${process.pid}.${Date.now()}.tmp`
    await writeFile(tempPath, JSON.stringify(store, null, 2), { mode: 0o600 })
    await rename(tempPath, this.path)
  }
}

export class EncryptedFileTokenStore extends EncryptedFileCredentialStore {}

function migrateLegacyStore(store: LegacyStoreFile): StoreFile {
  const users: Record<string, StoredTargetprocessCredential> = {}
  for (const [userId, entry] of Object.entries(store.users)) {
    users[userId] = {
      userId: entry.userId,
      email: entry.email,
      kind: "targetprocess_access_token",
      accessMode: "personal",
      policy: defaultAccessPolicy,
      encryptedToken: entry.encryptedToken,
      updatedAt: entry.updatedAt,
    }
  }
  return { version: 3, users }
}

function credentialFromEntry(entry: StoredTargetprocessCredential | undefined, encryptionKey: Buffer): TargetprocessCredential | null {
  if (!entry) return null
  if (entry.kind === "targetprocess_access_token") {
    if (!entry.encryptedToken) return null
    return {
      kind: "targetprocess_access_token",
      token: decryptSecret(entry.encryptedToken, encryptionKey),
    }
  }
  if (entry.kind === "targetprocess_shared_token") return { kind: "targetprocess_shared_token" }
  return null
}

function defaultAccount(): TargetprocessAccount {
  return {
    credential: null,
    accessMode: "personal",
    policy: defaultAccessPolicy,
  }
}
