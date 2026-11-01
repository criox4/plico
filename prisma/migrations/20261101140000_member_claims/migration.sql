-- "That's me" on a waiting spot: the request waits for whoever added it (or the group's creator) to confirm. splittr schema only.
ALTER TABLE "splittr"."member" ADD COLUMN "claimById" TEXT, ADD COLUMN "claimAt" TIMESTAMP(3);
