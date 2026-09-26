-- First-run profile and a backup UPI ID. splittr schema only.
ALTER TABLE "splittr"."user" ADD COLUMN "upi2" TEXT, ADD COLUMN "onboardedAt" TIMESTAMP(3);
ALTER TABLE "splittr"."member" ADD COLUMN "upi2" TEXT;
-- Everyone who already uses Plico has been through the old first run.
UPDATE "splittr"."user" SET "onboardedAt" = "createdAt" WHERE "onboardedAt" IS NULL;
