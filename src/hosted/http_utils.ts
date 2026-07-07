import type { IncomingMessage, ServerResponse } from "http"

export async function readBody(req: IncomingMessage, maxBytes = 1024 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buffer.length
    if (total > maxBytes) throw new Error("Request body too large")
    chunks.push(buffer)
  }
  return Buffer.concat(chunks)
}

export async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
  return new URLSearchParams((await readBody(req)).toString("utf8"))
}

export async function readJson<T>(req: IncomingMessage): Promise<T> {
  return JSON.parse((await readBody(req)).toString("utf8")) as T
}

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...headers,
  })
  res.end(JSON.stringify(body))
}

export function sendText(res: ServerResponse, status: number, body: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
    ...headers,
  })
  res.end(body)
}

export function sendHtml(res: ServerResponse, status: number, body: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    "X-Frame-Options": "DENY",
    ...headers,
  })
  res.end(body)
}

export function redirect(res: ServerResponse, location: string, headers: Record<string, string> = {}): void {
  res.writeHead(302, { Location: location, "Cache-Control": "no-store", ...headers })
  res.end()
}

export function methodNotAllowed(res: ServerResponse): void {
  sendText(res, 405, "Method not allowed")
}

export function getCookie(req: IncomingMessage, name: string): string | undefined {
  const cookieHeader = req.headers.cookie
  if (!cookieHeader) return undefined
  for (const cookie of cookieHeader.split(";")) {
    const [rawName, ...rawValue] = cookie.trim().split("=")
    if (rawName === name) return decodeURIComponent(rawValue.join("="))
  }
  return undefined
}

export function setCookie(name: string, value: string, maxAgeSeconds: number): string {
  return `${name}=${encodeURIComponent(value)}; Max-Age=${maxAgeSeconds}; Path=/; HttpOnly; Secure; SameSite=Lax`
}

export function clearCookie(name: string): string {
  return `${name}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`
}
