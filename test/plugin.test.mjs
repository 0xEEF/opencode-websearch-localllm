import { test } from "node:test"
import assert from "node:assert/strict"

import plugin, {
  DUCKDUCKGO_URL,
  DEFAULT_MAX_RESULTS,
  decodeDuckDuckGoUrl,
  fetchAndSimplify,
  isPrivateAddress,
  normalizeOptions,
  parseResults,
  pickPositiveInt,
  search,
  simplifyHtml,
  toContent,
} from "../dist/index.js"

const SAMPLE_RESULTS = `<!DOCTYPE html><html><body>
  <div class="result">
    <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage&amp;rut=abc">Example</a>
    <a class="result__snippet" href="#">Some snippet text.</a>
  </div>
  <div class="result">
    <a class="result__a" href="https://other.org/x">Other</a>
    <a class="result__snippet" href="#">Another snippet.</a>
  </div>
  <div class="result">
    <a class="result__a" href="https://duckduckgo.com/y">Duck home</a>
    <a class="result__snippet" href="#">Duck.</a>
  </div>
</body></html>`

function htmlResponse(html) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => "text/html" },
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(html))
        controller.close()
      },
    }),
  }
}

function mockFetch(route) {
  globalThis.fetch = async (url) => {
    const href = String(url)
    return route(href)
  }
}

test("pickPositiveInt falls back on invalid input", () => {
  assert.equal(pickPositiveInt("5", 3), 5)
  assert.equal(pickPositiveInt(7, 3), 7)
  assert.equal(pickPositiveInt("abc", 3), 3)
  assert.equal(pickPositiveInt("-1", 3), 3)
  assert.equal(pickPositiveInt("5.5", 3), 3)
  assert.equal(pickPositiveInt(0, 3), 3)
  assert.equal(pickPositiveInt(null, 3), 3)
  assert.equal(pickPositiveInt(undefined, 3), 3)
})

test("normalizeOptions fills defaults and honours overrides", () => {
  const defaults = normalizeOptions({})
  assert.equal(defaults.maxResults, DEFAULT_MAX_RESULTS)
  assert.equal(defaults.maxContent, 8000)
  assert.equal(defaults.fetchPages, true)
  assert.equal(typeof defaults.userAgent, "string")

  const custom = normalizeOptions({ maxResults: "3", maxContent: 100, fetchPages: false })
  assert.equal(custom.maxResults, 3)
  assert.equal(custom.maxContent, 100)
  assert.equal(custom.fetchPages, false)
})

test("isPrivateAddress detects private and loopback ranges", () => {
  assert.equal(isPrivateAddress("127.0.0.1"), true)
  assert.equal(isPrivateAddress("10.0.0.1"), true)
  assert.equal(isPrivateAddress("172.16.0.1"), true)
  assert.equal(isPrivateAddress("172.31.255.255"), true)
  assert.equal(isPrivateAddress("192.168.1.1"), true)
  assert.equal(isPrivateAddress("169.254.1.1"), true)
  assert.equal(isPrivateAddress("100.64.0.1"), true)
  assert.equal(isPrivateAddress("224.0.0.1"), true)
  assert.equal(isPrivateAddress("0.0.0.0"), true)
  assert.equal(isPrivateAddress("::1"), true)
  assert.equal(isPrivateAddress("fe80::1"), true)
  assert.equal(isPrivateAddress("fd00::1"), true)

  assert.equal(isPrivateAddress("8.8.8.8"), false)
  assert.equal(isPrivateAddress("93.184.216.34"), false)
  assert.equal(isPrivateAddress("2606:4700::1"), false)
})

test("decodeDuckDuckGoUrl unwraps redirects and leaves plain URLs", () => {
  assert.equal(
    decodeDuckDuckGoUrl("//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa&rut=1"),
    "https://example.com/a",
  )
  assert.equal(decodeDuckDuckGoUrl("https://example.com/b"), "https://example.com/b")
  assert.equal(decodeDuckDuckGoUrl(""), "")
})

test("parseResults extracts, decodes, and de-duplicates hits", () => {
  const hits = parseResults(SAMPLE_RESULTS)
  assert.equal(hits.length, 2)
  assert.equal(hits[0].url, "https://example.com/page")
  assert.equal(hits[0].title, "Example")
  assert.equal(hits[0].snippet, "Some snippet text.")
  assert.equal(hits[1].url, "https://other.org/x")
})

test("simplifyHtml returns main content as markdown, not a summary", () => {
  const html = `<!DOCTYPE html><html><head><title>T</title><style>.x{color:red}</style></head>
    <body>
      <nav><a href="#">Home</a></nav>
      <main>
        <h1>Hello</h1>
        <p>This is <strong>important</strong> content.</p>
        <script>alert('xss')</script>
      </main>
      <footer>© 2026</footer>
    </body></html>`
  const md = simplifyHtml(html, 1000)
  assert.match(md, /Hello/)
  assert.match(md, /This is \*\*important\*\* content\./)
  assert.doesNotMatch(md, /alert/)
  assert.doesNotMatch(md, /xss/)
  assert.doesNotMatch(md, /Home/)
  assert.doesNotMatch(md, /© 2026/)
})

test("simplifyHtml truncates at maxChars", () => {
  const html = `<body><main><p>${"a".repeat(500)}</p></main></body>`
  const md = simplifyHtml(html, 100)
  assert.ok(md.length <= 100 + 40)
  assert.match(md, /truncated/)
})

test("simplifyHtml handles empty input", () => {
  assert.equal(simplifyHtml("", 100), "")
  assert.equal(simplifyHtml("   ", 100), "")
})

test("search hits DuckDuckGo and builds results", async () => {
  mockFetch((href) => {
    assert.ok(href.startsWith(DUCKDUCKGO_URL))
    return htmlResponse(SAMPLE_RESULTS)
  })
  const results = await search("hello world", { maxResults: 3, fetchPages: false })
  assert.equal(results.length, 2)
  assert.equal(results[0].url, "https://example.com/page")
  assert.equal(results[0].content, "Some snippet text.")
  assert.equal(results[0].title, "Example")
})

test("search fetches and simplifies pages when fetchPages is on", async () => {
  mockFetch((href) => {
    if (href.startsWith(DUCKDUCKGO_URL)) return htmlResponse(SAMPLE_RESULTS)
    return htmlResponse(`<html><body><main><h1>Page</h1><p>Full content here.</p></main></body></html>`)
  })
  const results = await search("hello", { maxResults: 2, maxContent: 500 })
  assert.equal(results.length, 2)
  assert.match(results[0].content, /Full content here\./)
  assert.match(results[1].content, /Page/)
})

test("search falls back to snippet when page fetch fails", async () => {
  mockFetch((href) => {
    if (href.startsWith(DUCKDUCKGO_URL)) return htmlResponse(SAMPLE_RESULTS)
    return { ok: false, status: 404, statusText: "Not Found", headers: { get: () => "text/html" }, body: new ReadableStream({ start(c) { c.close() } }) }
  })
  const results = await search("hello", { maxResults: 2, maxContent: 500 })
  assert.equal(results[0].content, "Some snippet text.")
})

test("search rejects an empty query", async () => {
  await assert.rejects(() => search("   ", {}), /non-empty/)
})

test("search returns a placeholder when there are no results", async () => {
  mockFetch(() => htmlResponse("<html><body>nothing</body></html>"))
  const results = await search("zzzz", { maxResults: 5 })
  assert.equal(results.length, 1)
  assert.equal(results[0].title, "Web search")
})

test("fetchAndSimplify returns snippet on failure", async () => {
  mockFetch(() => ({ ok: false, status: 500, statusText: "Error", headers: { get: () => "text/html" }, body: new ReadableStream({ start(c) { c.close() } }) }))
  const content = await fetchAndSimplify({ url: "https://example.com", title: "T", snippet: "snippet" }, normalizeOptions({}))
  assert.equal(content, "snippet")
})

test("fetchAndSimplify refuses private addresses", async () => {
  const content = await fetchAndSimplify({ url: "http://127.0.0.1/admin", title: "T", snippet: "snippet" }, normalizeOptions({}))
  assert.equal(content, "snippet")
})

test("toContent renders markdown for each result", () => {
  const content = toContent([{ url: "https://a", title: "A", content: "body", time: {} }])
  assert.match(content, /## A/)
  assert.match(content, /https:\/\/a/)
  assert.match(content, /body/)
  assert.equal(toContent([]), "No search results.")
})

test("plugin exports a server module registering a websearch tool", async () => {
  assert.equal(typeof plugin.id, "string")
  assert.equal(plugin.id, "websearch")
  assert.equal(typeof plugin.server, "function")
  const hooks = await plugin.server({}, {})
  assert.ok(hooks.tool)
  assert.ok(hooks.tool["web-search"])
  assert.equal(hooks.tool["web-search"].description.length > 0, true)
  assert.equal(hooks.tool["web-search"].args.query instanceof Object, true)
})

test("plugin server tool execute runs a search via the tool", async () => {
  mockFetch((href) => {
    if (href.startsWith(DUCKDUCKGO_URL)) return htmlResponse(SAMPLE_RESULTS)
    return htmlResponse(`<html><body><main><h1>Page</h1><p>Full content here.</p></main></body></html>`)
  })
  const hooks = await plugin.server({}, { maxResults: 2, maxContent: 500 })
  const result = await hooks.tool["web-search"].execute({ query: "hello" }, { abort: new AbortController().signal })
  assert.equal(typeof result, "string")
  assert.match(result, /## Example/)
  assert.match(result, /Full content here\./)
})

test("plugin registers a web-simplify tool", async () => {
  const hooks = await plugin.server({}, {})
  assert.ok(hooks.tool["web-simplify"])
  assert.equal(typeof hooks.tool["web-simplify"].execute, "function")
  assert.ok(hooks.tool["web-simplify"].args.url instanceof Object)
  assert.match(hooks.tool["web-simplify"].description, /NOT a summary/)
})

test("web-simplify fetches a URL and returns simplified markdown", async () => {
  mockFetch((href) => htmlResponse(`<html><body><main><h1>My Page</h1><p>Real content here.</p></main><nav>links</nav></body></html>`))
  const hooks = await plugin.server({}, { maxContent: 1000 })
  const result = await hooks.tool["web-simplify"].execute(
    { url: "https://example.com/article" },
    { abort: new AbortController().signal },
  )
  assert.match(result, /Real content here\./)
  assert.doesNotMatch(result, /links/)
})

test("web-simplify throws on private addresses", async () => {
  mockFetch(() => htmlResponse("<html><body>should not be reached</body></html>"))
  const hooks = await plugin.server({}, {})
  await assert.rejects(
    () => hooks.tool["web-simplify"].execute({ url: "http://127.0.0.1/admin" }, { abort: new AbortController().signal }),
    /private|loopback|SSRF|public/i,
  )
})

test("web-simplify throws when no readable content", async () => {
  mockFetch(() => htmlResponse("<html><head><title>x</title></head><body></body></html>"))
  const hooks = await plugin.server({}, {})
  await assert.rejects(
    () => hooks.tool["web-simplify"].execute({ url: "https://example.com/empty" }, { abort: new AbortController().signal }),
    /readable content|extract/i,
  )
})
