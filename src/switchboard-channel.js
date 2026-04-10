#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import fs from 'fs'
import path from 'path'
import os from 'os'

const RELAY_DIR      = process.env.SWITCHBOARD_DATA_DIR ?? path.join(os.homedir(), '.switchboard')
const MSG_FILE       = path.join(RELAY_DIR, 'messages.json')
const SESSIONS_FILE  = path.join(RELAY_DIR, 'sessions.json')
const LOCK_FILE      = path.join(RELAY_DIR, 'messages.lock')
const HISTORY_FILE   = path.join(RELAY_DIR, 'history.jsonl')

const agentId = process.env.RELAY_AGENT_ID

// ── file-lock helpers (mirrored from relay-mcp.js) ───────────────────────────

function waitForLock(timeout = 2000) {
  const start = Date.now()
  while (fs.existsSync(LOCK_FILE)) {
    if (Date.now() - start > timeout) break
    const t = Date.now(); while (Date.now() - t < 10) {}
  }
  fs.writeFileSync(LOCK_FILE, process.pid.toString())
}

function releaseLock() {
  try { fs.unlinkSync(LOCK_FILE) } catch {}
}

function withLock(fn) {
  waitForLock()
  try { return fn() } finally { releaseLock() }
}

// ── history helpers (mirrored from relay-mcp.js) ─────────────────────────────

function currentMonthTag() {
  const now = new Date()
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  return `${y}-${m}`
}

function rotateHistoryIfNeeded() {
  if (!fs.existsSync(HISTORY_FILE)) return
  try {
    const firstLine = fs.readFileSync(HISTORY_FILE, 'utf8').split('\n').find(Boolean)
    if (!firstLine) return
    const entry = JSON.parse(firstLine)
    const fileMonth = entry.timestamp?.slice(0, 7)
    if (fileMonth && fileMonth !== currentMonthTag()) {
      fs.renameSync(HISTORY_FILE, path.join(RELAY_DIR, `history-${fileMonth}.jsonl`))
    }
  } catch {}
}

// ── session registry helpers ──────────────────────────────────────────────────

function readSessions() {
  try {
    if (!fs.existsSync(SESSIONS_FILE)) return {}
    return JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'))
  } catch { return {} }
}

function writeSessions(data) {
  fs.writeFileSync(SESSIONS_FILE, JSON.stringify(data, null, 2))
}

function isPidAlive(pid) {
  try { process.kill(pid, 0); return true } catch { return false }
}

// ── message helpers ───────────────────────────────────────────────────────────

function readMessages() {
  try {
    if (!fs.existsSync(MSG_FILE)) return {}
    return JSON.parse(fs.readFileSync(MSG_FILE, 'utf8'))
  } catch { return {} }
}

function writeMessages(data) {
  fs.writeFileSync(MSG_FILE, JSON.stringify(data, null, 2))
}

// ── stale inbox flush ─────────────────────────────────────────────────────────

function flushStaleMessages(agentId) {
  withLock(() => {
    const data = readMessages()
    const inbox = data[agentId] ?? []
    if (inbox.length === 0) return

    const flushedAt = new Date().toISOString()
    rotateHistoryIfNeeded()
    for (const msg of inbox) {
      const record = {
        type:               'stale_flush',
        timestamp:          flushedAt,
        agent:              agentId,
        original_from:      msg.from,
        original_to:        msg.to,
        original_thread:    msg.thread ?? null,
        original_message:   msg.message,
        original_timestamp: msg.timestamp,
        original_id:        msg.id,
        flushed_at:         flushedAt,
        reason:             'session_start'
      }
      try {
        fs.appendFileSync(HISTORY_FILE, JSON.stringify(record) + '\n')
      } catch {}
    }

    data[agentId] = []
    writeMessages(data)
    process.stderr.write(`Flushed ${inbox.length} stale message(s) for "${agentId}" to history (session start)\n`)
  })
}

// ── clean exit handler ────────────────────────────────────────────────────────

function registerCleanExit(agentId) {
  let cleaned = false
  function cleanUp() {
    if (cleaned) return
    cleaned = true
    try {
      withLock(() => {
        const sessions = readSessions()
        if (sessions[agentId] && sessions[agentId].pid === process.pid) {
          delete sessions[agentId]
          writeSessions(sessions)
        }
      })
    } catch {}
  }
  process.on('SIGTERM', () => { cleanUp(); process.exit(0) })
  process.on('SIGINT',  () => { cleanUp(); process.exit(0) })
  // Backup for Windows where SIGTERM may not fire before TerminateProcess
  process.on('exit', cleanUp)
}

// ── startup ───────────────────────────────────────────────────────────────────

if (!agentId) {
  process.stderr.write('RELAY_AGENT_ID not set — channel will not watch inbox\n')

  const mcp = new Server(
    { name: 'switchboard-channel', version: '1.0.0' },
    {
      capabilities: { experimental: { 'claude/channel': {} } },
      instructions: 'You are an unnamed agent on the Switchboard relay.'
    }
  )
  await mcp.connect(new StdioServerTransport())
} else {
  withLock(() => {
    const sessions = readSessions()
    if (sessions[agentId]) {
      const { pid, startedAt, cwd } = sessions[agentId]
      if (isPidAlive(pid)) {
        process.stderr.write(
          `Error: "${agentId}" is already claimed by PID ${pid} (started ${startedAt} in ${cwd}). Pick a different name or stop the other session.\n`
        )
        process.exit(1)
      }
    }

    sessions[agentId] = {
      pid:       process.pid,
      startedAt: new Date().toISOString(),
      cwd:       process.cwd()
    }
    writeSessions(sessions)
  })

  flushStaleMessages(agentId)

  const mcp = new Server(
    { name: 'switchboard-channel', version: '1.0.0' },
    {
      capabilities: {
        experimental: { 'claude/channel': {} }
      },
      instructions: [
        `You are agent "${agentId}" on the Switchboard relay.`,
        `When a <channel source="switchboard-channel"> event arrives, it means`,
        `another agent has sent you a message.`,
        `Immediately call read_messages({ agent_id: "${agentId}" }) to retrieve`,
        `the full message, then respond using send_message.`,
        `Keep responses concise and focused. Do not generate filler content.`
      ].join(' ')
    }
  )

  await mcp.connect(new StdioServerTransport())

  let lastKnownCount = 0

  function getMessageCount() {
    try {
      if (!fs.existsSync(MSG_FILE)) return 0
      const data = JSON.parse(fs.readFileSync(MSG_FILE, 'utf8'))
      return (data[agentId] ?? []).length
    } catch { return 0 }
  }

  function getNewMessages() {
    try {
      if (!fs.existsSync(MSG_FILE)) return []
      const data = JSON.parse(fs.readFileSync(MSG_FILE, 'utf8'))
      return data[agentId] ?? []
    } catch { return [] }
  }

  async function handleFileChange() {
    await new Promise(r => setTimeout(r, 100))

    const messages = getNewMessages()
    const count = messages.length

    if (count > lastKnownCount) {
      lastKnownCount = count
      const newest = messages[messages.length - 1]

      await mcp.notification({
        method: 'notifications/claude/channel',
        params: {
          content: `New message from ${newest.from}: ${newest.message.slice(0, 200)}${newest.message.length > 200 ? '...' : ''}`,
          meta: {
            from:    newest.from,
            thread:  newest.thread ?? 'none',
            pending: String(count)
          }
        }
      })
    } else {
      lastKnownCount = count
    }
  }

  // Accept both 'change' and 'rename' events — Windows fires 'rename' for
  // content modifications, not just file renames. Filtering to 'change' only
  // silently disables the watcher on Windows.
  if (fs.existsSync(MSG_FILE)) {
    fs.watch(MSG_FILE, { persistent: true }, async () => {
      await handleFileChange()
    })
  } else {
    const dirWatcher = fs.watch(RELAY_DIR, { persistent: true }, async (event, filename) => {
      if (filename === 'messages.json' && fs.existsSync(MSG_FILE)) {
        lastKnownCount = getMessageCount()
        dirWatcher.close()

        fs.watch(MSG_FILE, { persistent: true }, async () => {
          await handleFileChange()
        })
      }
    })
  }

  registerCleanExit(agentId)
}
