#!/usr/bin/env node
/**
 * Claude Code Relay — MCP server v2
 *
 * Tools: send_message, broadcast, read_messages, wait_for_message,
 *        relay_status, clear_relay,
 *        acquire_lock, release_lock, list_locks,
 *        read_history
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import fs from "fs";
import path from "path";
import os from "os";

const RELAY_DIR   = process.env.SWITCHBOARD_DATA_DIR ?? path.join(os.homedir(), ".switchboard");
const MSG_FILE    = path.join(RELAY_DIR, "messages.json");
const LOCK_FILE   = path.join(RELAY_DIR, "messages.lock");
const NAMED_LOCKS = path.join(RELAY_DIR, "locks.json");

if (!fs.existsSync(RELAY_DIR)) fs.mkdirSync(RELAY_DIR, { recursive: true });

function currentMonthTag() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

function activeHistoryFile() {
  return path.join(RELAY_DIR, "history.jsonl");
}

function rotateHistoryIfNeeded() {
  const active = activeHistoryFile();
  if (!fs.existsSync(active)) return;
  try {
    const firstLine = fs.readFileSync(active, "utf8").split("\n").find(Boolean);
    if (!firstLine) return;
    const entry = JSON.parse(firstLine);
    const fileMonth = entry.timestamp?.slice(0, 7);
    if (fileMonth && fileMonth !== currentMonthTag()) {
      fs.renameSync(active, path.join(RELAY_DIR, `history-${fileMonth}.jsonl`));
    }
  } catch {}
}

function waitForLock(timeout = 2000) {
  const start = Date.now();
  while (fs.existsSync(LOCK_FILE)) {
    if (Date.now() - start > timeout) break;
    const t = Date.now(); while (Date.now() - t < 10) {}
  }
  fs.writeFileSync(LOCK_FILE, process.pid.toString());
}

function releaseLock() {
  try { fs.unlinkSync(LOCK_FILE); } catch {}
}

function withLock(fn) {
  waitForLock();
  try { return fn(); } finally { releaseLock(); }
}

function readMessages() {
  try {
    if (!fs.existsSync(MSG_FILE)) return {};
    return JSON.parse(fs.readFileSync(MSG_FILE, "utf8"));
  } catch { return {}; }
}

function writeMessages(data) {
  fs.writeFileSync(MSG_FILE, JSON.stringify(data, null, 2));
}

function readNamedLocks() {
  try {
    if (!fs.existsSync(NAMED_LOCKS)) return {};
    return JSON.parse(fs.readFileSync(NAMED_LOCKS, "utf8"));
  } catch { return {}; }
}

function writeNamedLocks(data) {
  fs.writeFileSync(NAMED_LOCKS, JSON.stringify(data, null, 2));
}

function appendHistory(record) {
  try {
    rotateHistoryIfNeeded();
    fs.appendFileSync(activeHistoryFile(), JSON.stringify(record) + "\n");
  } catch {}
}

function makeMsg(from, to, message, thread) {
  return {
    id:        `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    from, to,
    thread:    thread ?? null,
    message,
    timestamp: new Date().toISOString(),
    read:      false,
  };
}

function formatMessages(messages) {
  return messages.map(m => {
    const thread = m.thread ? ` [${m.thread}]` : "";
    return `[${m.timestamp}]${thread} From: ${m.from}\n${m.message}`;
  }).join("\n\n─────────────────\n\n");
}

const server = new McpServer({ name: "claude-relay", version: "2.0.0" });

server.tool(
  "send_message",
  "Send a message to another agent by name.",
  {
    from:    z.string().describe("Your agent name"),
    to:      z.string().describe("Recipient agent name"),
    message: z.string().describe("The message content"),
    thread:  z.string().optional().describe("Optional thread label"),
  },
  async ({ from, to, message, thread }) => {
    const msg = makeMsg(from, to, message, thread);
    withLock(() => {
      const data = readMessages();
      if (!data[to]) data[to] = [];
      data[to].push(msg);
      writeMessages(data);
    });
    appendHistory({ type: "message", ...msg });
    return { content: [{ type: "text", text: `✓ Message queued for ${to}.` }] };
  }
);

server.tool(
  "broadcast",
  "Send a message to all known agents except yourself. Agents are discovered from the relay inbox — they need to have called read_messages at least once to be registered.",
  {
    from:    z.string().describe("Your agent name"),
    message: z.string().describe("The message to broadcast to all agents"),
    thread:  z.string().optional().describe("Optional thread label"),
  },
  async ({ from, message, thread }) => {
    let recipients = [];
    withLock(() => {
      const data = readMessages();
      recipients = Object.keys(data).filter(k => k !== from);
      for (const to of recipients) {
        const msg = makeMsg(from, to, message, thread);
        data[to].push(msg);
        appendHistory({ type: "broadcast", ...msg });
      }
      writeMessages(data);
    });
    if (recipients.length === 0) {
      return { content: [{ type: "text", text: "No other agents registered yet. They need to call read_messages once to appear in the relay." }] };
    }
    return { content: [{ type: "text", text: `✓ Broadcast sent to: ${recipients.join(", ")}` }] };
  }
);

server.tool(
  "read_messages",
  "Read pending messages in your inbox. Calling this also registers you as a known agent for broadcasts.",
  {
    agent_id: z.string().describe("Your agent name"),
    thread:   z.string().optional().describe("Filter to a specific thread label"),
    keep:     z.boolean().optional().describe("If true, messages stay in inbox after reading (default: false)"),
  },
  async ({ agent_id, thread, keep = false }) => {
    let messages;
    withLock(() => {
      const data = readMessages();
      if (!data[agent_id]) data[agent_id] = [];
      let inbox = data[agent_id];
      if (thread) inbox = inbox.filter(m => m.thread === thread);
      messages = inbox;
      if (!keep) {
        data[agent_id] = thread
          ? data[agent_id].filter(m => m.thread !== thread)
          : [];
        writeMessages(data);
      }
    });
    if (!messages || messages.length === 0) {
      return { content: [{ type: "text", text: `No pending messages for "${agent_id}".` }] };
    }
    return { content: [{ type: "text", text: formatMessages(messages) }] };
  }
);

server.tool(
  "wait_for_message",
  "Block until a message arrives. Use when you need a reply before continuing.",
  {
    agent_id:        z.string().describe("Your agent name"),
    timeout_seconds: z.number().optional().describe("Timeout in seconds (default: 120)"),
  },
  async ({ agent_id, timeout_seconds = 120 }) => {
    const deadline = Date.now() + timeout_seconds * 1000;
    while (Date.now() < deadline) {
      const data = readMessages();
      const messages = data[agent_id] ?? [];
      if (messages.length > 0) {
        withLock(() => {
          const d = readMessages();
          d[agent_id] = [];
          writeMessages(d);
        });
        return { content: [{ type: "text", text: formatMessages(messages) }] };
      }
      await new Promise(r => setTimeout(r, 2000));
    }
    return { content: [{ type: "text", text: `No message arrived for "${agent_id}" within ${timeout_seconds}s.` }] };
  }
);

server.tool(
  "relay_status",
  "See pending message counts and active named locks.",
  {},
  async () => {
    const msgs  = readMessages();
    const locks = readNamedLocks();
    const lines = [];
    lines.push("── messages ──");
    if (Object.keys(msgs).length === 0) {
      lines.push("  (no agents registered)");
    } else {
      for (const [agent, inbox] of Object.entries(msgs)) {
        lines.push(`  ${agent}: ${inbox.length} pending`);
      }
    }
    lines.push("\n── named locks ──");
    const active = Object.entries(locks).filter(([, v]) => v.held);
    if (active.length === 0) {
      lines.push("  (none held)");
    } else {
      for (const [resource, info] of active) {
        const age = Math.round((Date.now() - new Date(info.acquired_at).getTime()) / 1000);
        lines.push(`  🔒 ${resource} — ${info.holder} (${age}s / ${info.ttl_seconds}s TTL)`);
      }
    }
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }
);

server.tool(
  "clear_relay",
  "Wipe messages from the relay.",
  {
    agent_id: z.string().optional().describe("Clear only this agent's inbox. Omit to clear all."),
  },
  async ({ agent_id }) => {
    withLock(() => {
      const data = readMessages();
      if (agent_id) { data[agent_id] = []; }
      else { Object.keys(data).forEach(k => { data[k] = []; }); }
      writeMessages(data);
    });
    return { content: [{ type: "text", text: agent_id ? `Cleared inbox for ${agent_id}.` : "Relay cleared." }] };
  }
);

server.tool(
  "acquire_lock",
  "Claim exclusive access to a named resource (table, file, migration, etc). Always acquire before touching shared resources and release when done.",
  {
    resource:    z.string().describe("Resource name, e.g. 'users_table', 'migrations', 'schema.sql'"),
    holder:      z.string().describe("Your agent name"),
    ttl_seconds: z.number().optional().describe("Auto-release after this many seconds if you forget (default: 300)"),
  },
  async ({ resource, holder, ttl_seconds = 300 }) => {
    let result;
    withLock(() => {
      const locks = readNamedLocks();
      const existing = locks[resource];
      if (existing?.held) {
        const age = (Date.now() - new Date(existing.acquired_at).getTime()) / 1000;
        if (age < existing.ttl_seconds) {
          result = { success: false, holder: existing.holder, age: Math.round(age), ttl: existing.ttl_seconds };
          return;
        }
      }
      locks[resource] = { held: true, holder, acquired_at: new Date().toISOString(), ttl_seconds };
      writeNamedLocks(locks);
      appendHistory({ type: "lock_acquired", resource, holder, timestamp: new Date().toISOString() });
      result = { success: true };
    });
    if (!result.success) {
      return { content: [{ type: "text", text: `✗ "${resource}" is locked by ${result.holder} (held for ${result.age}s of ${result.ttl}s TTL). Try again later or check list_locks.` }] };
    }
    return { content: [{ type: "text", text: `✓ Lock acquired on "${resource}". Call release_lock when done.` }] };
  }
);

server.tool(
  "release_lock",
  "Release a named lock so other agents can access the resource.",
  {
    resource: z.string().describe("Resource name to release"),
    holder:   z.string().describe("Your agent name — must match who acquired it"),
  },
  async ({ resource, holder }) => {
    let result;
    withLock(() => {
      const locks = readNamedLocks();
      const existing = locks[resource];
      if (!existing?.held)            { result = { ok: false, reason: "not currently held" }; return; }
      if (existing.holder !== holder) { result = { ok: false, reason: `held by ${existing.holder}, not ${holder}` }; return; }
      locks[resource] = { held: false, holder: null, released_at: new Date().toISOString() };
      writeNamedLocks(locks);
      appendHistory({ type: "lock_released", resource, holder, timestamp: new Date().toISOString() });
      result = { ok: true };
    });
    if (!result.ok) {
      return { content: [{ type: "text", text: `✗ Could not release "${resource}": ${result.reason}` }] };
    }
    return { content: [{ type: "text", text: `✓ Lock released on "${resource}".` }] };
  }
);

server.tool(
  "list_locks",
  "See all named locks and whether they are currently held or free.",
  {},
  async () => {
    const locks = readNamedLocks();
    if (Object.keys(locks).length === 0) {
      return { content: [{ type: "text", text: "No locks registered yet." }] };
    }
    const lines = Object.entries(locks).map(([resource, info]) => {
      if (info.held) {
        const age = Math.round((Date.now() - new Date(info.acquired_at).getTime()) / 1000);
        return `🔒 ${resource} — held by ${info.holder} (${age}s / ${info.ttl_seconds}s TTL)`;
      }
      return `🔓 ${resource} — free`;
    });
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }
);

server.tool(
  "read_history",
  "Read the history log. Defaults to the current month. Use month param to read an archived month.",
  {
    limit:       z.number().optional().describe("Most recent N entries to return (default: 50)"),
    filter:      z.string().optional().describe("Filter by agent name or resource name"),
    type:        z.enum(["message", "broadcast", "lock_acquired", "lock_released"]).optional().describe("Filter by event type"),
    month:       z.string().optional().describe("Read an archived month, e.g. '2026-03'. Omit for current month."),
    list_months: z.boolean().optional().describe("If true, list all available history files and return."),
  },
  async ({ limit = 50, filter, type, month, list_months }) => {
    try {
      if (list_months) {
        const files = fs.readdirSync(RELAY_DIR)
          .filter(f => f.startsWith("history") && f.endsWith(".jsonl"))
          .sort();
        return { content: [{ type: "text", text: files.length ? files.join("\n") : "No history files yet." }] };
      }
      const file = month ? path.join(RELAY_DIR, `history-${month}.jsonl`) : activeHistoryFile();
      if (!fs.existsSync(file)) {
        return { content: [{ type: "text", text: month ? `No history file for ${month}.` : "No history yet." }] };
      }
      let entries = fs.readFileSync(file, "utf8")
        .split("\n").filter(Boolean)
        .map(l => { try { return JSON.parse(l); } catch { return null; } })
        .filter(Boolean);
      if (type)   entries = entries.filter(e => e.type === type);
      if (filter) entries = entries.filter(e =>
        e.from === filter || e.to === filter || e.holder === filter || e.resource === filter
      );
      const recent = entries.slice(-limit);
      const formatted = recent.map(e => {
        if (e.type === "message" || e.type === "broadcast") {
          const thread = e.thread ? ` [${e.thread}]` : "";
          return `[${e.timestamp}] ${e.type.toUpperCase()}${thread} ${e.from} → ${e.to ?? "all"}: ${e.message}`;
        }
        if (e.type === "lock_acquired") return `[${e.timestamp}] LOCK   ${e.holder} acquired "${e.resource}"`;
        if (e.type === "lock_released") return `[${e.timestamp}] UNLOCK ${e.holder} released "${e.resource}"`;
        return JSON.stringify(e);
      }).join("\n");
      return { content: [{ type: "text", text: `${recent.length} entries (${month ?? currentMonthTag()}):\n\n${formatted}` }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error reading history: ${e.message}` }] };
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
