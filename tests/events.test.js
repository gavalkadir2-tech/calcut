const test = require("node:test");
const assert = require("node:assert");
const { extract } = require("./helpers");

const { eventIcs } = new Function(extract("  function eventIcs(", "  async function saveEventToCalendar(") + "; return { eventIcs };")();

test("an event becomes a calendar file the phone can open", () => {
  const when = Date.UTC(2026, 10, 7, 18, 30);
  const ics = eventIcs({ title: "Doğum günü; pasta, müzik", when, place: "Ev" });
  const lines = ics.split("\r\n");
  assert.strictEqual(lines[0], "BEGIN:VCALENDAR");
  assert.ok(lines.includes("DTSTART:20261107T183000Z"));
  assert.ok(lines.includes("DTEND:20261107T193000Z"));
  assert.ok(lines.includes("SUMMARY:Doğum günü\\; pasta\\, müzik"));
  assert.ok(lines.includes("LOCATION:Ev"));
  assert.strictEqual(lines[lines.length - 1], "END:VCALENDAR");
});

test("no LOCATION line without a place", () => {
  assert.ok(!eventIcs({ title: "x", when: Date.now(), place: "" }).includes("LOCATION"));
});
