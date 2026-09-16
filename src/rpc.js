// T3 uses Effect RPC's JSON WebSocket protocol. Tickets are short-lived and never returned.
export async function rpc(base, request, method, signal) {
  const { ticket } = await request("/api/auth/websocket-ticket", {}, signal);
  if (typeof ticket !== "string")
    throw new Error("Could not obtain WebSocket ticket.");
  const url = new URL("/ws", base);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("wsTicket", ticket);
  const bounded = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(30000)])
    : AbortSignal.timeout(30000);
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    let done = false;
    const finish = (error, result) => {
      if (done) return;
      done = true;
      bounded.removeEventListener("abort", abort);
      socket.close();
      error ? reject(new Error("T3 RPC failed.")) : resolve(result);
    };
    const abort = () => finish(true);
    bounded.addEventListener("abort", abort, { once: true });
    if (bounded.aborted) return abort();
    socket.onopen = () =>
      socket.send(
        JSON.stringify({
          _tag: "Request",
          id: "0",
          tag: method,
          payload: {},
          headers: [],
        }),
      );
    socket.onerror = () => finish(true);
    socket.onclose = () => finish(true);
    socket.onmessage = (event) => {
      try {
        const frames = JSON.parse(event.data);
        for (const message of Array.isArray(frames) ? frames : [frames]) {
          if (message._tag === "Ping") {
            socket.send(JSON.stringify({ _tag: "Pong" }));
            continue;
          }
          if (message._tag === "Exit" && message.requestId === "0") {
            finish(message.exit._tag !== "Success", message.exit.value);
          }
        }
      } catch {
        finish(true);
      }
    };
  });
}
