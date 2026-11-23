-- Rate limits kept in the database, so they survive a deploy and hold across several API processes. splittr schema only.
CREATE TABLE "splittr"."rate_hit" (
  "id" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "rate_hit_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "rate_hit_key_at_idx" ON "splittr"."rate_hit"("key", "at");
CREATE INDEX "rate_hit_at_idx" ON "splittr"."rate_hit"("at");

-- One UPI transaction ID proves one live settlement: enforced, so two proofs racing can't both pass.
-- (Partial, so Prisma's schema can't describe it; like the friendship trigger, it lives here only.)
CREATE UNIQUE INDEX "expense_utr_live_key" ON "splittr"."expense"("utr") WHERE "utr" IS NOT NULL AND "settle" AND "deletedAt" IS NULL;
