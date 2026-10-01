-- People by phone: a verified number per account, a personal friend link, and phone lookups on spots. splittr schema only.
ALTER TABLE "splittr"."user" ADD COLUMN "verifiedPhone" TEXT, ADD COLUMN "phoneVerifiedAt" TIMESTAMP(3), ADD COLUMN "friendCode" TEXT;
CREATE UNIQUE INDEX "user_verifiedPhone_key" ON "splittr"."user"("verifiedPhone");
CREATE UNIQUE INDEX "user_friendCode_key" ON "splittr"."user"("friendCode");
CREATE INDEX "member_phone_idx" ON "splittr"."member"("phone");
-- Existing phone labels to the one stored form (normPhone in src/logic.ts); anything unreadable stays as typed.
UPDATE "splittr"."member" SET "phone" = CASE
  WHEN regexp_replace("phone", '[\s().-]', '', 'g') ~ '^\+[1-9]\d{7,14}$' THEN regexp_replace("phone", '[\s().-]', '', 'g')
  WHEN regexp_replace("phone", '[\s().-]', '', 'g') ~ '^(0|91)?[6-9]\d{9}$' THEN '+91' || right(regexp_replace("phone", '[\s().-]', '', 'g'), 10)
  ELSE "phone" END
WHERE "phone" IS NOT NULL;
