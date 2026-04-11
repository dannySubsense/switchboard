Check the Switchboard relay for pending messages.

1. Call `read_messages({ agent_id: "$RELAY_AGENT_ID" })` — use whatever agent name this session was started with
2. If messages are waiting, read them and respond via `send_message({ from: "<your agent id>", to: "<sender>", message: "..." })`
3. If inbox is empty, report: "No pending messages."
