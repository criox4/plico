-- People are accounts or email placeholders: drop name-only/phone-only guests (dev data) and the expenses they're in.
DELETE FROM "splittr"."expense" WHERE "id" IN (
  SELECT s."expenseId" FROM "splittr"."expense_share" s JOIN "splittr"."member" m ON m."id" = s."memberId"
  WHERE m."userId" IS NULL AND m."email" IS NULL);
DELETE FROM "splittr"."member" WHERE "userId" IS NULL AND "email" IS NULL;

-- The money audit replaces expense_event; scripts/backfill-audit.mts rebuilds the chain for existing expenses.
DROP TABLE "splittr"."expense_event";
CREATE TABLE "splittr"."audit_event" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "expenseId" TEXT,
    "memberId" TEXT,
    "version" INTEGER,
    "revertOf" INTEGER,
    "byId" TEXT,
    "byName" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "before" JSONB,
    "after" JSONB,
    "effect" JSONB NOT NULL,
    "prevHash" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    CONSTRAINT "audit_event_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "audit_event_groupId_seq_key" ON "splittr"."audit_event"("groupId", "seq");
CREATE INDEX "audit_event_groupId_at_idx" ON "splittr"."audit_event"("groupId", "at");
CREATE INDEX "audit_event_expenseId_version_idx" ON "splittr"."audit_event"("expenseId", "version");
ALTER TABLE "splittr"."audit_event" ADD CONSTRAINT "audit_event_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "splittr"."group"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "splittr"."group" ADD COLUMN "auditSeq" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "splittr"."group" ADD COLUMN "auditHash" TEXT NOT NULL DEFAULT '0000000000000000000000000000000000000000000000000000000000000000';
ALTER TABLE "splittr"."group" ADD COLUMN "directKey" TEXT;
CREATE UNIQUE INDEX "group_directKey_key" ON "splittr"."group"("directKey");
