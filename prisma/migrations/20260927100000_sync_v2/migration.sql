-- Sync v2: versioned expenses, soft deletes, edit history.
ALTER TABLE "splittr"."expense" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "splittr"."expense" ADD COLUMN "deletedAt" TIMESTAMP(3);
ALTER TABLE "splittr"."expense" ADD COLUMN "updatedById" TEXT;
CREATE INDEX "expense_groupId_updatedAt_idx" ON "splittr"."expense"("groupId", "updatedAt");

CREATE TABLE "splittr"."expense_event" (
    "id" TEXT NOT NULL,
    "expenseId" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "action" TEXT NOT NULL,
    "revertOf" INTEGER,
    "byId" TEXT,
    "byName" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "before" JSONB,
    "after" JSONB,
    CONSTRAINT "expense_event_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "expense_event_groupId_at_idx" ON "splittr"."expense_event"("groupId", "at");
CREATE INDEX "expense_event_expenseId_version_idx" ON "splittr"."expense_event"("expenseId", "version");
ALTER TABLE "splittr"."expense_event" ADD CONSTRAINT "expense_event_expenseId_fkey" FOREIGN KEY ("expenseId") REFERENCES "splittr"."expense"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: every existing expense starts its history with a "created" event.
INSERT INTO "splittr"."expense_event" ("id", "expenseId", "groupId", "version", "action", "byId", "byName", "at", "after")
SELECT gen_random_uuid()::text, e."id", e."groupId", 1, 'created', e."createdById", COALESCE(u."name", 'Someone'), e."createdAt",
  jsonb_build_object('title', e."title", 'cat', e."cat", 'date', e."date", 'amount', e."amount", 'mode', e."mode", 'input', e."input",
    'settle', e."settle", 'pending', e."pending", 'rejected', e."rejected", 'receipt', e."receipt", 'repeatNext', e."repeatNext", 'repeatDay', e."repeatDay",
    'shares', COALESCE((SELECT jsonb_agg(jsonb_build_object('memberId', s."memberId", 'paid', s."paid", 'owed', s."owed") ORDER BY s."memberId")
      FROM "splittr"."expense_share" s WHERE s."expenseId" = e."id"), '[]'::jsonb))
FROM "splittr"."expense" e LEFT JOIN "splittr"."user" u ON u."id" = e."createdById";
