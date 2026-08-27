// Mock OpenRouter server: exercises ranking, SSE streaming, tool calls, and 429 failover.
// Usage: node test/mock-server.mjs &
//        OPENROUTER_BASE_URL=http://localhost:4999 OPENROUTER_API_KEY=test tether run "..."
import { createServer } from "node:http";

const freeModels = [
  {
    id: "alpha/coder-large:free",
    name: "Alpha Coder",
    created: 2,
    context_length: 1000000,
    pricing: { prompt: "0", completion: "0" },
    supported_parameters: ["tools"],
  },
  {
    id: "beta/helper:free",
    name: "Beta Helper",
    created: 1,
    context_length: 128000,
    pricing: { prompt: "0", completion: "0" },
    supported_parameters: ["tools"],
  },
];
const programming = [{ id: "alpha/coder-large", created: 2, context_length: 1000000 }];

let alphaCalls = 0;
const sse = (res, events) => {
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const e of events) res.write(`data: ${JSON.stringify(e)}\n\n`);
  res.write("data: [DONE]\n\n");
  res.end();
};
const delta = (d, finish = null) => ({ choices: [{ delta: d, finish_reason: finish }] });

createServer((req, res) => {
  if (req.url === "/auth/keys" && req.method === "POST") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ key: "mock-oauth-key" }));
  }
  if (req.url.startsWith("/models")) {
    const url = new URL(req.url, "http://x");
    const data = url.searchParams.get("category") === "programming" ? programming : freeModels;
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ data }));
  }
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const { model, messages } = JSON.parse(body);
    if (model.startsWith("alpha/") && ++alphaCalls === 1) {
      // First hit on the top model: rate-limited -> harness must fail over to beta.
      res.writeHead(429, { "content-type": "application/json", "retry-after": "60" });
      return res.end(JSON.stringify({ error: { message: "Rate limit exceeded", code: 429 } }));
    }
    const last = messages[messages.length - 1];
    if (last.role === "user") {
      // Step 1: model asks to read the file (arguments split across chunks).
      return sse(res, [
        delta({
          tool_calls: [
            {
              index: 0,
              id: "call_1",
              type: "function",
              function: { name: "read_file", arguments: '{"path": "ma' },
            },
          ],
        }),
        delta({ tool_calls: [{ index: 0, function: { arguments: 'th_util.py"}' } }] }),
        delta({}, "tool_calls"),
      ]);
    }
    if (last.role === "tool" && last.content.includes("a - b")) {
      // Step 2: model fixes the bug.
      return sse(res, [
        delta({
          tool_calls: [
            {
              index: 0,
              id: "call_2",
              type: "function",
              function: {
                name: "edit_file",
                arguments: JSON.stringify({
                  path: "math_util.py",
                  old_string: "return a - b",
                  new_string: "return a + b",
                }),
              },
            },
          ],
        }),
        delta({}, "tool_calls"),
      ]);
    }
    // Step 3: done.
    return sse(res, [
      delta({ content: "Fixed: add() now returns " }),
      delta({ content: "a + b." }),
      delta({}, "stop"),
    ]);
  });
}).listen(4999, () => console.log("mock up"));
