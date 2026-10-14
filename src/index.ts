/**
 * opencode-websearch-localllm
 *
 * A self-contained web search plugin for OpenCode (v1 plugin API). It searches
 * DuckDuckGo itself, fetches the result pages, and hands back a SIMPLIFIED
 * MARKDOWN VERSION of each page — not a summary. Because no remote LLM
 * endpoint is involved, it works with ANY model opencode has loaded,
 * including local ones (llama.cpp, Ollama, etc.).
 *
 * It registers a custom tool named `websearch` (which overrides the built-in
 * cloud-backed tool) so the search runs entirely on the plugin side.
 */

import { load, type CheerioAPI, type Cheerio } from "cheerio"
import TurndownService from "turndown"
import type { Element } from "domhandler"
import { tool, type PluginInput } from "@opencode-ai/plugin"

/** Default number of search results returned per query. */
export const DEFAULT_MAX_RESULTS = 5

/** Default maximum simplified characters returned per page. */
export const DEFAULT_MAX_CONTENT = 8000

/** Default maximum bytes of HTML fetched for one page. */
export const DEFAULT_MAX_BYTES = 2_000_000

/** Default per-request timeout in milliseconds. */
export const DEFAULT_TIMEOUT_MS = 15_000

/** Default maximum redirects to follow. */
export const DEFAULT_MAX_REDIRECTS = 5

/** Default user agent sent when fetching pages. */
export const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"

/** DuckDuckGo HTML search endpoint (no API key required). */
export const DUCKDUCKGO_URL = "https://html.duckduckgo.com/html/"

/** Fallback URL used when nothing else is available. */
export const FALLBACK_URL = "https://duckduckgo.com"

/** A single search result returned to OpenCode. */
export interface WebSearchResult {
  url: string
  title: string
  content: string
  time: Record<string, unknown>
}

/** A raw hit parsed from the DuckDuckGo results page. */
export interface SearchHit {
  url: string
  title: string
  snippet: string
}

/** Options accepted by the plugin (from `ctx.options` or the tool). */
export interface WebsearchOptions {
  /** Max search results returned per query (default {@link DEFAULT_MAX_RESULTS}). */
  maxResults?: number | string
  /** Max simplified characters returned per page (default {@link DEFAULT_MAX_CONTENT}). */
  maxContent?: number | string
  /** Max HTML bytes fetched per page (default {@link DEFAULT_MAX_BYTES}). */
  maxBytes?: number | string
  /** Per-request timeout in ms (default {@link DEFAULT_TIMEOUT_MS}). */
  timeoutMs?: number | string
  /** Max redirects to follow (default {@link DEFAULT_MAX_REDIRECTS}). */
  maxRedirects?: number | string
  /** User agent sent when fetching (default {@link DEFAULT_USER_AGENT}). */
  userAgent?: string
  /** Fetch and simplify result pages (default true). When false, snippets only. */
  fetchPages?: boolean
}

/** Plugin options accepted from the config array form: `["opencode-websearch-localllm", opts]`. */
export type WebsearchOptionsRecord = Record<string, unknown>

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

/** Return a trimmed non-empty string, or undefined for any other value. */
function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

/** Parse a positive integer option, falling back to `fallback`. */
export function pickPositiveInt(value: unknown, fallback: number): number {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value > 0 ? value : fallback
  }
  if (typeof value === "string") {
    const trimmed = value.trim()
    if (!/^\d+$/.test(trimmed)) return fallback
    const parsed = Number(trimmed)
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback
  }
  return fallback
}

/** Fully resolved options: all numbers coerced to concrete positive ints. */
export interface NormalizedOptions {
  maxResults: number
  maxContent: number
  maxBytes: number
  timeoutMs: number
  maxRedirects: number
  userAgent: string
  fetchPages: boolean
}

/** Normalise options into concrete, safe numbers/strings. */
export function normalizeOptions(raw: WebsearchOptions = {}): NormalizedOptions {
  return {
    maxResults: pickPositiveInt(raw.maxResults, DEFAULT_MAX_RESULTS),
    maxContent: pickPositiveInt(raw.maxContent, DEFAULT_MAX_CONTENT),
    maxBytes: pickPositiveInt(raw.maxBytes, DEFAULT_MAX_BYTES),
    timeoutMs: pickPositiveInt(raw.timeoutMs, DEFAULT_TIMEOUT_MS),
    maxRedirects: pickPositiveInt(raw.maxRedirects, DEFAULT_MAX_REDIRECTS),
    userAgent: readString(raw.userAgent) ?? DEFAULT_USER_AGENT,
    fetchPages: raw.fetchPages !== false,
  }
}

/** Reject with the signal's reason if `signal` aborts before `promise` settles. */
function withAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise
  if (signal.aborted) {
    promise.catch(() => {})
    return Promise.reject(signal.reason ?? new Error("The web search was aborted"))
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new Error("The web search was aborted"))
    signal.addEventListener("abort", onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort)
        resolve(value)
      },
      (error) => {
        signal.removeEventListener("abort", onAbort)
        reject(error)
      },
    )
  })
}

/* ------------------------------------------------------------------ *
 * SSRF-safe fetching
 * ------------------------------------------------------------------ */

/**
 * Return the effective IPv4/IPv6 addresses for a hostname, or throw.
 * Used to block private/loopback targets (SSRF protection).
 */
async function lookupAddresses(hostname: string): Promise<string[]> {
  const { lookup } = await import("node:dns/promises")
  try {
    const result = await lookup(hostname, { all: true })
    return result.map((entry) => entry.address)
  } catch {
    return []
  }
}

/** True when `ip` is in a private/loopback/link-local/reserved range. */
export function isPrivateAddress(ip: string): boolean {
  if (ip.includes(":")) {
    const lower = ip.toLowerCase()
    if (lower === "::" || lower === "::1") return true
    if (lower.startsWith("fc") || lower.startsWith("fd")) return true // ULA
    if (lower.startsWith("fe8") || lower.startsWith("fe9") || lower.startsWith("fea") || lower.startsWith("feb"))
      return true // link-local
    if (lower.startsWith("fe80")) return true
    return false
  }
  const parts = ip.split(".").map((p) => Number(p))
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p))) return true
  const [a, b] = parts as [number, number, number, number]
  if (a === 10) return true
  if (a === 127) return true
  if (a === 0) return true
  if (a === 169 && b === 254) return true // link-local
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 100 && b >= 64 && b <= 127) return true // CGNAT
  if (a >= 224) return true // multicast/reserved
  return false
}

/**
 * Validate a URL for SSRF safety: http(s) scheme and a public hostname.
 * Throws on private, loopback, or link-local targets.
 */
export async function assertPublicUrl(url: URL, signal?: AbortSignal): Promise<void> {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Unsupported URL scheme "${url.protocol}"`)
  }
  const host = url.hostname.toLowerCase()
  if (!host) throw new Error("Missing hostname")
  // Fast-path reject obvious loopback / metadata names before DNS.
  if (host === "localhost" || host === "localhost." || host.endsWith(".localhost")) {
    throw new Error(`Refusing to fetch private host "${host}"`)
  }
  if (host.endsWith(".local") || host.endsWith(".internal")) {
    throw new Error(`Refusing to fetch private host "${host}"`)
  }
  // Metadata endpoints.
  if (host === "169.254.169.254" || host.endsWith(".metadata.google.internal")) {
    throw new Error(`Refusing to fetch metadata endpoint "${host}"`)
  }
  // Literal IPs.
  if (/^[\d.]+$/.test(host)) {
    if (isPrivateAddress(host)) throw new Error(`Refusing to fetch private address "${host}"`)
    return
  }
  if (host.includes(":") && !host.includes(".")) {
    if (isPrivateAddress(host)) throw new Error(`Refusing to fetch private address "${host}"`)
    return
  }
  // DNS: reject if ANY resolved address is private (guards rebinding).
  const addresses = await withAbort(lookupAddresses(host), signal)
  if (addresses.length === 0) {
    throw new Error(`Could not resolve host "${host}"`)
  }
  for (const addr of addresses) {
    if (isPrivateAddress(addr)) {
      throw new Error(`Refusing to fetch host "${host}" resolving to private address "${addr}"`)
    }
  }
}

/** Read a fetch body as text, capping at `maxBytes`. Returns {text, truncated}. */
async function readBody(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<{ text: string; truncated: boolean }> {
  if (!body) return { text: "", truncated: false }
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let text = ""
  let total = 0
  let truncated = false
  try {
    for (;;) {
      if (signal?.aborted) throw signal.reason ?? new Error("The web search was aborted")
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        truncated = true
        // Decode the portion that fits within the cap.
        const over = total - maxBytes
        const slice = value.subarray(0, Math.max(0, value.byteLength - over))
        text += decoder.decode(slice, { stream: false })
        break
      }
      text += decoder.decode(value, { stream: true })
    }
  } finally {
    try {
      await reader.cancel()
    } catch {
      /* ignore */
    }
  }
  return { text, truncated }
}

/**
 * Fetch a URL following redirects with an absolute cap, enforcing SSRF rules
 * on every hop. Returns the final HTML text and resolved URL.
 */
export async function fetchHtml(
  url: string,
  options: Partial<{ timeoutMs: number; maxBytes: number; maxRedirects: number; userAgent: string; signal: AbortSignal }> = {},
): Promise<{ html: string; url: string; truncated: boolean }> {
  const timeoutMs = pickPositiveInt(options.timeoutMs, DEFAULT_TIMEOUT_MS)
  const maxBytes = pickPositiveInt(options.maxBytes, DEFAULT_MAX_BYTES)
  const maxRedirects = pickPositiveInt(options.maxRedirects, DEFAULT_MAX_REDIRECTS)
  const userAgent = readString(options.userAgent) ?? DEFAULT_USER_AGENT

  let current = new URL(url)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error("Request timed out")), timeoutMs)
  const onOuterAbort = () => controller.abort(options.signal?.reason)
  options.signal?.addEventListener("abort", onOuterAbort, { once: true })

  try {
    for (let hop = 0; hop <= maxRedirects; hop++) {
      await withAbort(assertPublicUrl(current, controller.signal), controller.signal)

      const response = await fetch(current, {
        redirect: "manual",
        signal: controller.signal,
        headers: {
          "user-agent": userAgent,
          accept: "text/html,application/xhtml+xml",
          "accept-language": "en, *;q=0.5",
        },
      })

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location")
        if (!location) return { html: "", url: current.href, truncated: false }
        const next = new URL(location, current)
        await response.body?.cancel().catch(() => {})
        current = next
        continue
      }

      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`)
      }

      const type = response.headers.get("content-type") ?? ""
      if (type && !/text\/html|application\/xhtml\+xml/i.test(type)) {
        await response.body?.cancel().catch(() => {})
        return { html: "", url: current.href, truncated: false }
      }

      const { text, truncated } = await readBody(response.body, maxBytes, controller.signal)
      return { html: text, url: current.href, truncated }
    }
    throw new Error(`Too many redirects (${maxRedirects})`)
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener("abort", onOuterAbort)
  }
}

/* ------------------------------------------------------------------ *
 * Search
 * ------------------------------------------------------------------ */

/** Decode a DuckDuckGo redirect URL back to its real target. */
export function decodeDuckDuckGoUrl(href: string): string {
  if (!href) return ""
  const raw = href.startsWith("//") ? `https:${href}` : href
  try {
    const url = new URL(raw)
    if (url.hostname.endsWith("duckduckgo.com")) {
      const uddg = url.searchParams.get("uddg")
      if (uddg) return uddg
    }
    return url.href
  } catch {
    return raw
  }
}

/**
 * Parse the DuckDuckGo HTML results page into structured hits, de-duplicated
 * by URL, preserving first-seen order.
 */
export function parseResults(html: string): SearchHit[] {
  const $ = load(html)
  const seen = new Set<string>()
  const hits: SearchHit[] = []
  $(".result").each((_, el) => {
    const link = $(el).find("a.result__a").first()
    const url = decodeDuckDuckGoUrl(link.attr("href") ?? "")
    const title = link.text().trim()
    const snippet = $(el).find(".result__snippet").first().text().trim()
    if (!url || !title || seen.has(url)) return
    // Skip DuckDuckGo's own internal/utility pages (not redirect targets).
    try {
      const host = new URL(url).hostname
      if (host === "duckduckgo.com" || host.endsWith(".duckduckgo.com")) return
    } catch {
      /* keep */
    }
    seen.add(url)
    hits.push({ url, title, snippet })
  })
  return hits
}

/**
 * Query DuckDuckGo and return the top `maxResults` hits.
 * Returns an empty array on any network/parse failure (never throws to caller
 * except on abort).
 */
export async function searchDuckDuckGo(
  query: string,
  options: Partial<{ maxResults: number; timeoutMs: number; userAgent: string; signal: AbortSignal }> = {},
): Promise<SearchHit[]> {
  const maxResults = pickPositiveInt(options.maxResults, DEFAULT_MAX_RESULTS)
  const q = new URLSearchParams({ q: query })
  const target = `${DUCKDUCKGO_URL}?${q.toString()}`
  const { html } = await fetchHtml(target, {
    timeoutMs: options.timeoutMs,
    userAgent: options.userAgent,
    signal: options.signal,
  })
  return parseResults(html).slice(0, maxResults)
}

/* ------------------------------------------------------------------ *
 * Simplification
 * ------------------------------------------------------------------ */

const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" })
turndown.remove([
  "script", "style", "noscript", "iframe", "svg", "canvas", "form", "nav",
  "aside", "header", "footer", "button", "input", "select", "textarea",
  "img", "picture", "video", "audio", "link", "meta",
])

/** Return the element whose subtree has the most visible text, if any. */
function mainContent($: CheerioAPI, candidates: Cheerio<Element>): Element | undefined {
  let best: Element | undefined
  let bestLen = -1
  candidates.each((_, el) => {
    const $el = $(el)
    const len = $el.text().replace(/\s+/g, " ").trim().length
    if (len > bestLen) {
      bestLen = len
      best = el
    }
  })
  return best
}

/**
 * Turn raw HTML into a SIMPLIFIED MARKDOWN VERSION of the page: the main
 * content, stripped of chrome, scripts, and markup, capped at `maxChars`.
 * This is not a summary — it is the page's own content, just readable.
 */
export function simplifyHtml(html: string, maxChars: number = DEFAULT_MAX_CONTENT): string {
  if (!html || !html.trim()) return ""
  const $ = load(html)

  const candidates = $("article, main, [role='main'], .content, #content, .post, .entry, .article, body")
  const rootEl = mainContent($, candidates)
  const source = rootEl ? $(rootEl) : $("body")
  // Turndown keeps <img> as markdown images; drop them (noise for LLM text).
  source.find("img, picture, svg, iframe, video, audio, canvas").remove()
  let md = turndown.turndown(source.html() ?? "")

  // Collapse excessive whitespace and blank lines.
  md = md.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim()

  if (maxChars > 0 && md.length > maxChars) {
    md = md.slice(0, maxChars).trim()
    // Avoid cutting mid-line awkwardly; append a marker.
    md = `${md}\n… (content truncated)`
  }
  return md
}

/**
 * Fetch a URL and return its simplified markdown, or the snippet if the fetch
 * fails. Never throws for a page failure; only aborts propagate.
 */
export async function fetchAndSimplify(
  hit: SearchHit,
  options: NormalizedOptions,
  signal?: AbortSignal,
): Promise<string> {
  try {
    const { html } = await fetchHtml(hit.url, {
      timeoutMs: options.timeoutMs,
      maxBytes: options.maxBytes,
      maxRedirects: options.maxRedirects,
      userAgent: options.userAgent,
      signal,
    })
    if (!html || !html.trim()) return hit.snippet
    return simplifyHtml(html, options.maxContent) || hit.snippet
  } catch (error) {
    if (signal?.aborted) throw error
    return hit.snippet
  }
}

/**
 * Fetch a specific URL and return its simplified Markdown. Unlike
 * `fetchAndSimplify` (which tolerates page failures by falling back to a
 * snippet), this throws on failure so an explicit URL fetch surfaces the error.
 * SSRF protection is applied on every redirect hop.
 */
export async function simplifyUrl(
  url: string,
  options: NormalizedOptions,
  signal?: AbortSignal,
): Promise<string> {
  const { html, url: finalUrl } = await fetchHtml(url, {
    timeoutMs: options.timeoutMs,
    maxBytes: options.maxBytes,
    maxRedirects: options.maxRedirects,
    userAgent: options.userAgent,
    signal,
  })
  if (!html || !html.trim()) {
    throw new Error(`No readable content found at ${url}`)
  }
  const simplified = simplifyHtml(html, options.maxContent)
  if (!simplified) {
    throw new Error(`Could not extract readable content from ${url}`)
  }
  return `# ${finalUrl}\n\n${simplified}`
}

/**
 * Run the full search: query DuckDuckGo, optionally fetch and simplify the
 * result pages, and build the result list OpenCode expects.
 */
export async function search(
  rawQuery: unknown,
  rawOptions: WebsearchOptions = {},
  signal?: AbortSignal,
): Promise<WebSearchResult[]> {
  const query = typeof rawQuery === "string" ? rawQuery.trim() : ""
  if (!query) throw new Error("query must be a non-empty string")
  const options = normalizeOptions(rawOptions)

  const hits = await withAbort(
    searchDuckDuckGo(query, { maxResults: options.maxResults, timeoutMs: options.timeoutMs, userAgent: options.userAgent, signal }),
    signal,
  )

  const results: WebSearchResult[] = []
  for (const hit of hits) {
    let content = hit.snippet
    if (options.fetchPages) {
      content = await withAbort(fetchAndSimplify(hit, options, signal), signal)
    }
    results.push({
      url: hit.url,
      title: hit.title || hit.url,
      content,
      time: {},
    })
  }

  if (results.length === 0) {
    results.push({
      url: FALLBACK_URL,
      title: "Web search",
      content: "The search returned no results.",
      time: {},
    })
  }
  return results
}

/** Textual form of the results for the Code Mode tool's `content`. */
export function toContent(results: readonly WebSearchResult[]): string {
  const valid = (Array.isArray(results) ? results : []).filter(
    (r): r is WebSearchResult => typeof r?.url === "string" && r.url.length > 0,
  )
  if (valid.length === 0) return "No search results."
  return valid.map((r) => `## ${r.title}\n- ${r.url}\n\n${r.content}`).join("\n\n")
}

/* ------------------------------------------------------------------ *
 * Plugin (OpenCode v1 plugin API)
 * ------------------------------------------------------------------ */

/**
 * OpenCode v1 plugin: `{ server }` is the module's default export, where
 * `server` is an async function returning hooks. We register a custom
 * `web-search` tool so the model (any provider, including llama.cpp) can search
 * the web without a cloud-backed search endpoint.
 */
async function server(_input: PluginInput, options?: WebsearchOptionsRecord): Promise<{ tool: { "web-search": ReturnType<typeof tool>; "web-simplify": ReturnType<typeof tool> } }> {
  const opts = normalizeOptions((options ?? {}) as WebsearchOptions)

  return {
    tool: {
      "web-search": tool({
        description:
          "Search the web and return simplified Markdown of the result pages (not summaries). " +
          "Use this tool to access up-to-date information beyond the model's knowledge cutoff. " +
          "After answering, include a 'Sources:' section with the relevant URLs.",
        args: {
          query: tool.schema.string().min(1).describe("The web search query"),
        },
        async execute(args, context) {
          const results = await search(args.query, opts, context.abort)
          return toContent(results)
        },
      }),
      "web-simplify": tool({
        description:
          "Fetch a single URL and return a SIMPLIFIED MARKDOWN version of the page's actual content — NOT a summary. " +
          "The full readable text of the page is preserved with very minimal information loss; only boilerplate " +
          "(scripts, styles, navigation, forms, images) is stripped. Prefer this over webfetch when you want the " +
          "page's complete substance rather than a condensed digest. Use web-search to discover URLs first.",
        args: {
          url: tool.schema.string().min(1).describe("The absolute URL to fetch and simplify (e.g. https://example.com/page)"),
        },
        async execute(args, context) {
          return simplifyUrl(args.url, opts, context.abort)
        },
      }),
    },
  }
}

export default {
  id: "websearch",
  server,
}
