-- Settle first, verify after: how a settlement was verified, and the payer's proof. splittr schema only.
ALTER TABLE "splittr"."expense" ADD COLUMN "verifiedBy" TEXT, ADD COLUMN "verifiedAt" TIMESTAMP(3), ADD COLUMN "proof" JSONB, ADD COLUMN "utr" TEXT;
CREATE INDEX "expense_utr_idx" ON "splittr"."expense"("utr");
-- Settlements already confirmed by their payee (or recorded by them) count as verified by the payee.
UPDATE "splittr"."expense" SET "verifiedBy" = 'payee', "verifiedAt" = "updatedAt" WHERE "settle" AND NOT "pending" AND NOT "rejected";
