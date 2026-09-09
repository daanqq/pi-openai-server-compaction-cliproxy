import { execFileSync } from "node:child_process";
import { mkdirSync, existsSync, lstatSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const localNodeModules = join(repoRoot, "node_modules");

function packagePathSegments(packageName) {
  return packageName.split("/");
}

function npmGlobalRoot() {
  try {
    return execFileSync("npm", ["root", "-g"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
}

function candidateRoots() {
  const roots = new Set();
  roots.add(localNodeModules);

  const globalRoot = npmGlobalRoot();
  if (globalRoot) roots.add(globalRoot);

  const voltaPiRoot = join(
    homedir(),
    ".volta",
    "tools",
    "image",
    "packages",
    "@earendil-works",
    "pi-coding-agent",
    "lib",
    "node_modules",
  );
  roots.add(voltaPiRoot);
  roots.add(join(voltaPiRoot, "@earendil-works", "pi-coding-agent", "node_modules"));

  return [...roots];
}

function resolveInstalledPackageDir(packageName) {
  const segments = packagePathSegments(packageName);
  for (const root of candidateRoots()) {
    const dir = join(root, ...segments);
    const packageJsonPath = join(dir, "package.json");
    if (existsSync(packageJsonPath)) {
      return dir;
    }
  }
  return undefined;
}

function ensureLocalPeerLink(packageName) {
  const localDir = join(localNodeModules, ...packagePathSegments(packageName));
  if (existsSync(join(localDir, "package.json"))) {
    return;
  }

  const targetDir = resolveInstalledPackageDir(packageName);
  if (!targetDir) {
    throw new Error(
      `Unable to locate peer dependency ${packageName}. Install Pi or add the package locally before running smoke.`,
    );
  }

  mkdirSync(dirname(localDir), { recursive: true });
  if (existsSync(localDir)) {
    const stat = lstatSync(localDir);
    if (stat.isSymbolicLink() || stat.isDirectory()) {
      rmSync(localDir, { recursive: true, force: true });
    }
  }
  symlinkSync(targetDir, localDir, "dir");
}

for (const packageName of [
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-ai",
]) {
  ensureLocalPeerLink(packageName);
}

const { default: extensionFactory } = await import(pathToFileURL(join(repoRoot, "src", "index.ts")).href);
assert.equal(typeof extensionFactory, "function", "extension entrypoint should export a function");

const {
  buildCodexWebSocketHeaders,
  buildRemoteCompactionHeaders,
  buildRemoteCompactionDetails,
  buildRemoteCompactionRequestBody,
  buildRemoteCompactionV2History,
  callRemoteCompactionEndpoint,
  extractRemoteCompactionDetails,
  normalizeResponseItemsForPrompt,
  parseRemoteCompactionV2Events,
  processCompactedHistory,
  reconstructRemoteCompactionStateFromBranch,
  remoteCompactionV2EndpointUrl,
} = await import(pathToFileURL(join(repoRoot, "src", "remote-compaction.ts")).href);
const {
  applyRemoteHistoryPayloadPatch,
  isConfiguredCompatibleResponsesModel,
  supportsRemoteCompactionModel,
} = await import(pathToFileURL(join(repoRoot, "src", "openai.ts")).href);
const {
  selectInputItemsForContinuation,
} = await import(pathToFileURL(join(repoRoot, "src", "openai-ws-stream.ts")).href);

const targetModelKey = "openai:openai-responses:gpt-5.4-nano";
const extensionConfig = {
  enabled: true,
  includeAzure: false,
  compatibleProviders: ["cliproxy"],
  compactThreshold: 0,
  thresholdRatio: 0.7,
  notify: false,
  usePreviousResponseId: false,
};
const reconstructed = reconstructRemoteCompactionStateFromBranch({
  branchEntries: [
    {
      type: "compaction",
      id: "cmp-1",
      details: {
        remoteCompaction: {
          version: 1,
          provider: "openai-responses-compact",
          modelKey: targetModelKey,
          replacementHistory: [
            {
              type: "compaction",
              encrypted_content: "ENCRYPTED",
            },
          ],
        },
      },
    },
    {
      type: "message",
      id: "user-a1",
      message: {
        role: "user",
        content: [{ type: "text", text: "KEEP_ME_ONE" }],
      },
    },
    {
      type: "message",
      id: "assistant-a1",
      message: {
        role: "assistant",
        provider: "openai",
        api: "openai-responses",
        model: "gpt-5.4-nano",
        content: [{ type: "text", text: "KEEP_REPLY_ONE" }],
      },
    },
    {
      type: "message",
      id: "user-b1",
      message: {
        role: "user",
        content: [{ type: "text", text: "DROP_ME" }],
      },
    },
    {
      type: "message",
      id: "assistant-b1",
      message: {
        role: "assistant",
        provider: "anthropic",
        api: "anthropic-messages",
        model: "claude-sonnet-4-6",
        content: [{ type: "text", text: "DROP_REPLY" }],
      },
    },
    {
      type: "message",
      id: "user-a2",
      message: {
        role: "user",
        content: [{ type: "text", text: "KEEP_ME_TWO" }],
      },
    },
    {
      type: "message",
      id: "assistant-a2",
      message: {
        role: "assistant",
        provider: "openai",
        api: "openai-responses",
        model: "gpt-5.4-nano",
        content: [{ type: "text", text: "KEEP_REPLY_TWO" }],
      },
    },
  ],
});
assert.ok(reconstructed, "expected reconstructed remote compaction state");
const reconstructedJson = JSON.stringify(reconstructed.explicitHistory);
assert.match(reconstructedJson, /KEEP_ME_ONE/);
assert.match(reconstructedJson, /KEEP_REPLY_ONE/);
assert.match(reconstructedJson, /KEEP_ME_TWO/);
assert.match(reconstructedJson, /KEEP_REPLY_TWO/);
assert.doesNotMatch(reconstructedJson, /DROP_ME/);
assert.doesNotMatch(reconstructedJson, /DROP_REPLY/);

const requestBody = buildRemoteCompactionRequestBody({
  model: {
    id: "gpt-5.4-nano",
  },
  input: [{ type: "compaction", encrypted_content: "ENCRYPTED" }],
  instructions: "system",
  tools: [{ type: "function", name: "read" }],
  parallelToolCalls: true,
  reasoning: { effort: "high", summary: "auto" },
  text: { verbosity: "medium" },
});
assert.equal(requestBody.model, "gpt-5.4-nano");
assert.equal(requestBody.stream, true);
assert.equal(requestBody.store, false);
assert.equal(requestBody.tool_choice, "auto");
assert.deepEqual(requestBody.include, ["reasoning.encrypted_content"]);
assert.deepEqual(requestBody.input.at(-1), { type: "compaction_trigger" });
assert.deepEqual(requestBody.reasoning, { effort: "high", summary: "auto" });
assert.deepEqual(requestBody.text, { verbosity: "medium" });
assert.equal(
  remoteCompactionV2EndpointUrl({
    provider: "openai",
    api: "openai-responses",
    baseUrl: "https://api.openai.com/v1",
  }, extensionConfig),
  "https://api.openai.com/v1/responses",
);
assert.equal(
  remoteCompactionV2EndpointUrl({
    provider: "openai-codex",
    api: "openai-codex-responses",
    baseUrl: "https://chatgpt.com/backend-api",
  }, extensionConfig),
  "https://chatgpt.com/backend-api/codex/responses",
);
const cliProxyModel = {
  provider: "cliproxy",
  api: "openai-responses",
  id: "sol",
  baseUrl: "http://127.0.0.1:8317/v1",
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
assert.equal(isConfiguredCompatibleResponsesModel(cliProxyModel, extensionConfig), true);
assert.equal(supportsRemoteCompactionModel(cliProxyModel, extensionConfig), true);
assert.equal(
  isConfiguredCompatibleResponsesModel(
    { ...cliProxyModel, provider: "unlisted-proxy" },
    extensionConfig,
  ),
  false,
);
assert.equal(
  remoteCompactionV2EndpointUrl(cliProxyModel, extensionConfig),
  "http://127.0.0.1:8317/v1/responses",
);
assert.deepEqual(
  applyRemoteHistoryPayloadPatch({
    payload: { model: "sol", input: [{ role: "user", content: "ordinary Pi history" }] },
    explicitHistory: [
      { type: "compaction", encrypted_content: "PROXY_ENCRYPTED" },
      { type: "message", role: "user", content: "new turn" },
    ],
  }),
  {
    model: "sol",
    input: [
      { type: "compaction", encrypted_content: "PROXY_ENCRYPTED" },
      { type: "message", role: "user", content: "new turn" },
    ],
  },
);

const extensionHandlers = new Map();
extensionFactory({
  registerProvider() {},
  on(eventName, handler) {
    const handlers = extensionHandlers.get(eventName) ?? [];
    handlers.push(handler);
    extensionHandlers.set(eventName, handlers);
  },
  getThinkingLevel() {
    return "medium";
  },
  getAllTools() {
    return [];
  },
  getActiveTools() {
    return [];
  },
});
const proxyCompactionEntry = {
  type: "compaction",
  id: "proxy-cmp-1",
  details: {
    remoteCompaction: {
      version: 2,
      provider: "openai-responses-compaction",
      implementation: "responses_compaction_v2",
      modelKey: "cliproxy:openai-responses:sol",
      replacementHistory: [{ type: "compaction", encrypted_content: "PROXY_ENCRYPTED" }],
    },
  },
};
const proxyContext = {
  cwd: repoRoot,
  model: cliProxyModel,
  hasUI: false,
  ui: { notify() {} },
  sessionManager: {
    getSessionId() {
      return "cliproxy-smoke-session";
    },
    getBranch() {
      return [proxyCompactionEntry];
    },
  },
};
await extensionHandlers.get("session_start")[0]({ reason: "startup" }, proxyContext);
await extensionHandlers.get("message_end")[0](
  {
    message: {
      role: "user",
      content: [{ type: "text", text: "portable summary" }],
    },
  },
  proxyContext,
);
const patchedProxyRequest = await extensionHandlers.get("before_provider_request")[0](
  { payload: { model: "sol", input: [{ role: "user", content: "portable summary" }] } },
  proxyContext,
);
assert.deepEqual(patchedProxyRequest.input, [
  { type: "compaction", encrypted_content: "PROXY_ENCRYPTED" },
  {
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: "portable summary" }],
  },
]);
assert.equal("previous_response_id" in patchedProxyRequest, false);

const parsedV2Events = parseRemoteCompactionV2Events([
  {
    type: "response.output_item.done",
    item: { type: "compaction", encrypted_content: "V2_ENCRYPTED" },
  },
  {
    type: "response.completed",
    response: { usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } },
  },
]);
assert.equal(parsedV2Events.compactionItem.type, "compaction");
const v2History = buildRemoteCompactionV2History(
  [
    { type: "message", role: "user", content: [{ type: "input_text", text: "retain user" }] },
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "summarize assistant" }] },
  ],
  parsedV2Events.compactionItem,
);
assert.deepEqual(v2History.map((item) => item.type), ["message", "compaction"]);
assert.equal(v2History[0].role, "user");

const normalizedPromptItems = normalizeResponseItemsForPrompt(
  [
    { type: "ghost_snapshot", data: "hidden" },
    {
      type: "message",
      role: "user",
      content: [{ type: "input_image", image_url: "data:image/png;base64,AAAA" }],
    },
    { type: "function_call", name: "read", call_id: "call-1", arguments: "{}" },
    { type: "function_call_output", call_id: "orphan", output: "drop" },
    { type: "image_generation_call", result: "base64" },
  ],
  { input: ["text"] },
);
assert.equal(normalizedPromptItems[0].type, "message");
assert.deepEqual(normalizedPromptItems[0].content, [
  { type: "input_text", text: "image content omitted because you do not support image input" },
]);
assert.deepEqual(normalizedPromptItems[2], {
  type: "function_call_output",
  call_id: "call-1",
  output: "aborted",
});
assert.equal(normalizedPromptItems[3].result, "");
assert.doesNotMatch(JSON.stringify(normalizedPromptItems), /orphan|ghost_snapshot/);

const compactedHistory = processCompactedHistory([
  { type: "message", role: "developer", content: [{ type: "input_text", text: "drop developer" }] },
  { type: "message", role: "user", content: [] },
  { type: "message", role: "user", content: [{ type: "input_text", text: "keep user" }] },
  { type: "message", role: "assistant", content: [{ type: "output_text", text: "keep assistant" }] },
  { type: "function_call", name: "read", call_id: "call-2", arguments: "{}" },
  { type: "compaction", encrypted_content: "keep" },
]);
assert.deepEqual(compactedHistory.map((item) => item.type), ["message", "message", "compaction"]);
assert.equal(compactedHistory[0].role, "user");
assert.equal(compactedHistory[1].role, "assistant");

const compactionHeaders = buildRemoteCompactionHeaders({
  model: {
    provider: "openai",
    api: "openai-responses",
    id: "gpt-5.4-nano",
  },
  config: extensionConfig,
  apiKey: "sk-test",
  sessionId: "session-123",
  headers: { "x-extra": "yes" },
});
assert.equal(compactionHeaders.authorization, "Bearer sk-test");
assert.equal(compactionHeaders.session_id, "session-123");
assert.equal(compactionHeaders["x-codex-window-id"], "session-123:0");
assert.match(compactionHeaders["x-codex-installation-id"], /^[0-9a-f-]{36}$/);
assert.equal(compactionHeaders["x-extra"], "yes");
assert.equal(compactionHeaders["x-codex-beta-features"], "remote_compaction_v2");
assert.equal(compactionHeaders.accept, "text/event-stream");

const cliProxyHeaders = buildRemoteCompactionHeaders({
  model: cliProxyModel,
  config: extensionConfig,
  apiKey: "proxy-key",
});
assert.equal(cliProxyHeaders.authorization, "Bearer proxy-key");
assert.equal(cliProxyHeaders.accept, "text/event-stream");
assert.equal(cliProxyHeaders["x-codex-beta-features"], "remote_compaction_v2");
assert.equal("x-codex-installation-id" in cliProxyHeaders, false);
assert.equal("x-codex-window-id" in cliProxyHeaders, false);
assert.equal("session_id" in cliProxyHeaders, false);

const originalFetch = globalThis.fetch;
let capturedProxyRequest;
globalThis.fetch = async (url, init) => {
  capturedProxyRequest = { url: String(url), init };
  return new Response(
    [
      'data: {"type":"response.output_item.done","item":{"type":"compaction","encrypted_content":"FETCH_ENCRYPTED"}}',
      'data: {"type":"response.completed","response":{"usage":{"input_tokens":9,"output_tokens":2,"total_tokens":11}}}',
      "",
    ].join("\n\n"),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
};
try {
  const proxyCompactionResult = await callRemoteCompactionEndpoint({
    model: cliProxyModel,
    config: extensionConfig,
    apiKey: "proxy-key",
    input: [{ type: "message", role: "user", content: "remember this" }],
    tools: [],
    parallelToolCalls: true,
  });
  assert.equal(capturedProxyRequest.url, "http://127.0.0.1:8317/v1/responses");
  assert.equal(capturedProxyRequest.init.method, "POST");
  const capturedBody = JSON.parse(capturedProxyRequest.init.body);
  assert.deepEqual(capturedBody.input.at(-1), { type: "compaction_trigger" });
  assert.equal(capturedProxyRequest.init.headers.authorization, "Bearer proxy-key");
  assert.equal(proxyCompactionResult.output.at(-1).encrypted_content, "FETCH_ENCRYPTED");
  assert.equal(proxyCompactionResult.usage.totalTokens, 11);
} finally {
  globalThis.fetch = originalFetch;
}

const websocketHeaders = buildCodexWebSocketHeaders("session-123");
assert.equal(websocketHeaders["x-client-request-id"], "session-123");
assert.equal(websocketHeaders.session_id, "session-123");
assert.equal(websocketHeaders["x-codex-window-id"], "session-123:0");

const detailsRoundTrip = extractRemoteCompactionDetails({
  remoteCompaction: buildRemoteCompactionDetails(
    {
      provider: "openai",
      api: "openai-responses",
      id: "gpt-5.4-nano",
    },
    [{ type: "compaction", encrypted_content: "ENCRYPTED" }],
    {
      input: 10,
      output: 20,
      cacheRead: 30,
      cacheWrite: 40,
      totalTokens: 100,
      cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
    },
  ),
});
assert.ok(detailsRoundTrip, "expected remote compaction details round trip");
assert.equal(detailsRoundTrip.usage?.cacheWrite, 40);
assert.equal(detailsRoundTrip.usage?.cost.total, 10);

const incrementalInput = selectInputItemsForContinuation({
  context: {
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: "old user" }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "old assistant" }],
      },
      {
        role: "user",
        content: [{ type: "text", text: "new user" }],
      },
    ],
  },
  model: { input: ["text"] },
  session: { lastContextLength: 2 },
  currentModelKey: targetModelKey,
  remoteCompactionState: undefined,
  previousResponseId: "resp_123",
});
assert.deepEqual(incrementalInput, [
  {
    type: "message",
    role: "user",
    content: "new user",
  },
]);

console.log("smoke ok");
