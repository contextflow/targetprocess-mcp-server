import { mkdir, readFile, rename, writeFile } from "fs/promises"
import { dirname } from "path"
import { decryptSecret, encryptSecret, type EncryptedValue } from "./security.js"

export type TargetprocessCredential =
  | { kind: "targetprocess_access_token"; token: string }
  | { kind: "frontdoor_api_key"; keyAccess: string; keySecret: string }

export type StoredTargetprocessToken = {
  userId: string
  email: string
  encryptedToken: EncryptedValue
  updatedAt: string
}

export type StoredTargetprocessCredential = {
  userId: string
  email: string
  kind: TargetprocessCredential["kind"]
  encryptedToken?: EncryptedValue
  encryptedKeyAccess?: EncryptedValue
  encryptedKeySecret?: EncryptedValue
  updatedAt: string
}

export interface TargetprocessCredentialStore {
  getCredential(userId: string): Promise<TargetprocessCredential | null>
  setCredential(userId: string, email: string, credential: TargetprocessCredential): Promise<void>
  deleteCredential(userId: string): Promise<void>
  hasCredential(userId: string): Promise<boolean>
}

type LegacyStoreFile = {
  version: 1
  users: Record<string, StoredTargetprocessToken>
}

type StoreFile = {
  version: 2
  users: Record<string, StoredTargetprocessCredential>
}

export class EncryptedFileCredentialStore implements TargetprocessCredentialStore {
  constructor(
    private readonly path: string,
    private readonly encryptionKey: Buffer,
  ) {}

  async getCredential(userId: string): Promise<TargetprocessCredential | null> {
    const store = await this.readStore()
    const entry = store.users[userId]
    if (!entry) return null
    if (entry.kind === "targetprocess_access_token") {
      if (!entry.encryptedToken) throw new Error("Stored Targetprocess access token is missing encryptedToken")
      return {
        kind: "targetprocess_access_token",
        token: decryptSecret(entry.encryptedToken, this.encryptionKey),
      }
    }
    if (!entry.encryptedKeyAccess || !entry.encryptedKeySecret) {
      throw new Error("Stored Frontdoor API key is missing encrypted fields")
    }
    return {
      kind: "frontdoor_api_key",
      keyAccess: decryptSecret(entry.encryptedKeyAccess, this.encryptionKey),
      keySecret: decryptSecret(entry.encryptedKeySecret, this.encryptionKey),
    }
  }

  async setCredential(userId: string, email: string, credential: TargetprocessCredential): Promise<void> {
    const store = await this.readStore()
    const base = {
      userId,
      email,
      kind: credential.kind,
      updatedAt: new Date().toISOString(),
    }
    store.users[userId] = credential.kind === "targetprocess_access_token"
      ? {
          ...base,
          encryptedToken: encryptSecret(credential.token, this.encryptionKey),
        }
      : {
          ...base,
          encryptedKeyAccess: encryptSecret(credential.keyAccess, this.encryptionKey),
          encryptedKeySecret: encryptSecret(credential.keySecret, this.encryptionKey),
        }
    await this.writeStore(store)
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
      if (parsed.version !== 2 || typeof parsed.users !== "object" || parsed.users === null) {
        throw new Error("Unsupported token store format")
      }
      return parsed
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { version: 2, users: {} }
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
      encryptedToken: entry.encryptedToken,
      updatedAt: entry.updatedAt,
    }
  }
  return { version: 2, users }
}
