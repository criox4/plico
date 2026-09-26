-- Who added each person, so only they can change a not-yet-joined person's UPI IDs or email. splittr schema only.
ALTER TABLE "splittr"."member" ADD COLUMN "addedById" TEXT;
UPDATE "splittr"."member" m SET "addedById" = a."byId"
FROM (SELECT DISTINCT ON ("memberId") "memberId", "byId" FROM "splittr"."audit_event" WHERE "kind" = 'member.invited' AND "byId" IS NOT NULL ORDER BY "memberId", "seq") a
WHERE a."memberId" = m."id";
-- Anyone without an invite entry: the group's creator.
UPDATE "splittr"."member" m SET "addedById" = g."createdById" FROM "splittr"."group" g
WHERE m."groupId" = g."id" AND m."addedById" IS NULL AND m."userId" IS NULL;
