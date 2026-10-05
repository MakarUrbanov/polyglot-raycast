/**
 * Minimal server-sent-events parser. Pure (no I/O) so it can be checked
 * offline: feed it decoded text in arbitrary chunks, get back the `data`
 * payload of every completed event. Handles LF and CRLF line endings,
 * multi-line `data:` fields, `:` comment lines, `event:`/`id:` lines (ignored —
 * both providers repeat the event type inside the JSON), and the `[DONE]`
 * sentinel some APIs send.
 */

export class SseParser {
  private buffer = "";
  private data: string[] = [];

  /** Feed the next decoded chunk; returns the payloads of completed events. */
  push(chunk: string): string[] {
    this.buffer += chunk;
    const events: string[] = [];
    let newline = this.buffer.indexOf("\n");
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline).replace(/\r$/, "");
      this.buffer = this.buffer.slice(newline + 1);
      this.readLine(line, events);
      newline = this.buffer.indexOf("\n");
    }
    return events;
  }

  /** End of stream: dispatch a final event that had no trailing blank line. */
  flush(): string[] {
    const events: string[] = [];
    if (this.buffer !== "") {
      this.readLine(this.buffer.replace(/\r$/, ""), events);
      this.buffer = "";
    }
    this.readLine("", events);
    return events;
  }

  private readLine(line: string, events: string[]): void {
    if (line === "") {
      // A blank line dispatches the event collected so far.
      const payload = this.data.join("\n");
      this.data = [];
      if (payload !== "" && payload !== "[DONE]") {
        events.push(payload);
      }
      return;
    }
    if (line.startsWith(":")) {
      return; // comment / keep-alive
    }
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    if (field !== "data") {
      return;
    }
    const value = colon === -1 ? "" : line.slice(colon + 1);
    this.data.push(value.startsWith(" ") ? value.slice(1) : value);
  }
}
