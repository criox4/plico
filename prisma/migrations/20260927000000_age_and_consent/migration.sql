-- Age band + parental consent for 13-17 year olds (DPDP Act 2023 s.9), and consent to AI reading.
ALTER TABLE "splittr"."user" ADD COLUMN "ageGroup" TEXT;
ALTER TABLE "splittr"."user" ADD COLUMN "guardianEmail" TEXT;
ALTER TABLE "splittr"."user" ADD COLUMN "guardianName" TEXT;
ALTER TABLE "splittr"."user" ADD COLUMN "guardianConsentAt" TIMESTAMP(3);
ALTER TABLE "splittr"."user" ADD COLUMN "aiConsentAt" TIMESTAMP(3);
