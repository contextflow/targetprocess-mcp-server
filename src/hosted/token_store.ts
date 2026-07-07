import { mkdir, readFile, rename, writeFile } from "fs/promises"
import { dirname } from "path"
import { decryptSecret, encryptSecret, type EncryptedValue } from "./security.js"

export type StoredTargetprocessToken = {
  userId: string
  email: string
  encryptedToken: EncryptedValue
  updatedAt: string
}

export interface TargetprocessTokenStore {
  getToken(userId: string): Promise<string | null>
  setToken(userId: string, email: string, token: string): Promise<void>
  deleteToken(userId: string): Promise<void>
  hasToken(userId: string): Promise<boolean>
}

type StoreFile = {
  version: 1
  users: Record<string, StoredTargetprocessToken>
}

export class EncryptedFileTokenStore implements TargetprocessTokenStore {
  constructor(
    private readonly path: string,
    private readonly encryptionKey: Buffer,
  ) {}

  async getToken(userId: string): Promise<string | null> {
    const store = await this.readStore()
    const entry = store.users[userId]
    if (!entry) return null
    return decryptSecret(entry.encryptedToken, this.encryptionKey)
  }

  async setToken(userId: string, email: string, token: string): Promise<void> {
    const store = await this.readStore()
    store.users[userId] = {
      userId,
      email,
      encryptedToken: encryptSecret(token, this.encryptionKey),
      updatedAt: new Date().toISOString(),
    }
    await this.writeStore(store)
  }

  async deleteToken(userId: string): Promise<void> {
    const store = await this.readStore()
    delete store.users[userId]
    await this.writeStore(store)
  }

  async hasToken(userId: string): Promise<boolean> {
    const store = await this.readStore()
    return Boolean(store.users[userId])
  }

  private async readStore(): Promise<StoreFile> {
    try {
      const raw = await readFile(this.path, "utf8")
      const parsed = JSON.parse(raw) as StoreFile
      if (parsed.version !== 1 || typeof parsed.users !== "object" || parsed.users === null) {
        throw new Error("Unsupported token store format")
      }
      return parsed
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { version: 1, users: {} }
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
