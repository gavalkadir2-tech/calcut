const test = require("node:test");
const assert = require("node:assert");
const { extract } = require("./helpers");

const src = extract("  const NICK_CHARS", "  const mentionPicker") +
  extract("  function mentionPattern(", "  // Wraps known");
const members = [{ uid: "u1", nickname: "ali" }, { uid: "u2", nickname: "ali_k" }, { uid: "u3", nickname: "çağrı" }];
const { mentionedUids } = new Function("groupMembersForMention", src + "; return { mentionedUids };")(() => members);

test("only whole @nicknames count as mentions", () => {
  assert.deepStrictEqual(mentionedUids("selam @ali nasılsın"), ["u1"]);
  assert.deepStrictEqual(mentionedUids("@ali_k bak"), ["u2"]);
  assert.deepStrictEqual(mentionedUids("@ali, @çağrı!"), ["u1", "u3"]);
  assert.deepStrictEqual(mentionedUids("mail@ali.com"), []);
  assert.deepStrictEqual(mentionedUids("@alis"), []);
});
