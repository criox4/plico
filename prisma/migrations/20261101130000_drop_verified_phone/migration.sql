-- WhatsApp phone verification is gone: a phone-added spot is claimed by its personal link or confirmed by whoever added it.
-- Also clears its pending codes from Better Auth's verification table. splittr schema only.
DROP INDEX IF EXISTS "splittr"."user_verifiedPhone_key";
ALTER TABLE "splittr"."user" DROP COLUMN IF EXISTS "verifiedPhone", DROP COLUMN IF EXISTS "phoneVerifiedAt";
DELETE FROM "splittr"."verification" WHERE "identifier" LIKE 'wa:%';
