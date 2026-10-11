-- Friendships that outlive the group: two accounts in the same group become friends, and stay friends after either leaves.
-- A trigger writes them, so every way a spot gets an account (made with one, claimed, verified email or phone) counts. splittr schema only.
CREATE TABLE "splittr"."friendship" (
    "userId" TEXT NOT NULL,
    "friendId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "friendship_pkey" PRIMARY KEY ("userId","friendId")
);
CREATE INDEX "friendship_friendId_idx" ON "splittr"."friendship"("friendId");
ALTER TABLE "splittr"."friendship" ADD CONSTRAINT "friendship_userId_fkey" FOREIGN KEY ("userId") REFERENCES "splittr"."user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "splittr"."friendship" ADD CONSTRAINT "friendship_friendId_fkey" FOREIGN KEY ("friendId") REFERENCES "splittr"."user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE FUNCTION "splittr"."befriend_member"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO "splittr"."friendship" ("userId", "friendId")
  SELECT x.a, x.b FROM "splittr"."member" m,
    LATERAL (VALUES (NEW."userId", m."userId"), (m."userId", NEW."userId")) AS x(a, b)
  WHERE m."groupId" = NEW."groupId" AND m."userId" IS NOT NULL AND m."userId" <> NEW."userId"
  ON CONFLICT DO NOTHING;
  RETURN NULL;
END $$;
CREATE TRIGGER "member_befriend" AFTER INSERT OR UPDATE OF "userId" ON "splittr"."member"
  FOR EACH ROW WHEN (NEW."userId" IS NOT NULL) EXECUTE FUNCTION "splittr"."befriend_member"();

-- Everyone who shares a group today.
INSERT INTO "splittr"."friendship" ("userId", "friendId")
SELECT DISTINCT a."userId", b."userId" FROM "splittr"."member" a JOIN "splittr"."member" b ON a."groupId" = b."groupId"
WHERE a."userId" IS NOT NULL AND b."userId" IS NOT NULL AND a."userId" <> b."userId"
ON CONFLICT DO NOTHING;
