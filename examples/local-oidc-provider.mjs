#!/usr/bin/env node

import { createServer } from "node:http"
import { createSign, generateKeyPairSync, randomBytes } from "node:crypto"

const port = positiveInteger(process.env.LOCAL_OIDC_PORT, 48080)
const host = process.env.LOCAL_OIDC_HOST || "127.0.0.1"
const issuer = trimTrailingSlash(process.env.LOCAL_OIDC_ISSUER || `http://localhost:${port}`)
const email = process.env.LOCAL_OIDC_EMAIL || "local.user@example.com"
const name = process.env.LOCAL_OIDC_NAME || "Local User"
const subject = process.env.LOCAL_OIDC_SUB || email
const groups = csv(process.env.LOCAL_OIDC_GROUPS)
const keyId = "local-dev-rs256"
const codes = new Map()

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
const publicJwk = {
  ...publicKey.export({ format: "jwk" }),
  kid: keyId,
  alg: "RS256",
  use: "sig",
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", issuer)

    if (req.method === "GET" && url.pathname === "/.well-known/openid-configuration") {
      sendJson(res, 200, {
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
      })
      return
    }

    if (req.method === "GET" && url.pathname === "/jwks") {
      sendJson(res, 200, { keys: [publicJwk] })
      return
    }

    if (req.method === "GET" && url.pathname === "/authorize") {
      const redirectUri = required(url.searchParams.get("redirect_uri"), "redirect_uri")
      const clientId = required(url.searchParams.get("client_id"), "client_id")
      const nonce = required(url.searchParams.get("nonce"), "nonce")
      const code = randomBase64Url(24)
      codes.set(code, {
        clientId,
        nonce,
        expiresAt: Date.now() + 5 * 60 * 1000,
      })

      const redirectUrl = new URL(redirectUri)
      redirectUrl.searchParams.set("code", code)
      const state = url.searchParams.get("state")
      if (state) redirectUrl.searchParams.set("state", state)
      redirect(res, redirectUrl.toString())
      return
    }

    if (req.method === "POST" && url.pathname === "/token") {
      const form = new URLSearchParams(await readBody(req))
      const code = form.get("code") || ""
      const grant = codes.get(code)
      codes.delete(code)
      if (!grant || grant.expiresAt <= Date.now()) {
        sendJson(res, 400, { error: "invalid_grant" })
        return
      }

      const clientId = form.get("client_id") || grant.clientId
      sendJson(res, 200, {
        token_type: "Bearer",
        expires_in: 3600,
        id_token: signIdToken({
          iss: issuer,
          sub: subject,
          aud: clientId,
          exp: Math.floor(Date.now() / 1000) + 3600,
          iat: Math.floor(Date.now() / 1000),
          nonce: grant.nonce,
          email,
          email_verified: true,
          name,
          groups,
        }),
      })
      return
    }

    sendText(res, 404, "Not found")
  } catch (error) {
    sendJson(res, 400, { error: error instanceof Error ? error.message : "bad_request" })
  }
})

server.listen(port, host, () => {
  console.error(`Local OIDC provider listening at ${issuer}`)
  console.error(`Mock user: ${email}`)
})

function signIdToken(payload) {
  const encodedHeader = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT", kid: keyId }))
  const encodedPayload = base64Url(JSON.stringify(payload))
  const signingInput = `${encodedHeader}.${encodedPayload}`
  const signer = createSign("RSA-SHA256")
  signer.update(signingInput)
  signer.end()
  return `${signingInput}.${base64Url(signer.sign(privateKey))}`
}

function redirect(res, location) {
  res.writeHead(302, { Location: location, "Cache-Control": "no-store" })
  res.end()
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  })
  res.end(JSON.stringify(body))
}

function sendText(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
  })
  res.end(body)
}

async function readBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  return Buffer.concat(chunks).toString("utf8")
}

function base64Url(value) {
  return Buffer.from(value)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
}

function randomBase64Url(bytes) {
  return base64Url(randomBytes(bytes))
}

function required(value, name) {
  if (!value) throw new Error(`${name} is required`)
  return value
}

function csv(value) {
  return (value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
}

function trimTrailingSlash(value) {
  return value.replace(/\/$/, "")
}

function positiveInteger(raw, fallback) {
  if (!raw) return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value <= 0) throw new Error("LOCAL_OIDC_PORT must be a positive integer")
  return value
}
