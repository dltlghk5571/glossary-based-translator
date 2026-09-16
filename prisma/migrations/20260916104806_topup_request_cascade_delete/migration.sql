-- DropForeignKey
ALTER TABLE "TokenTopUpRequest" DROP CONSTRAINT "TokenTopUpRequest_userId_fkey";

-- AddForeignKey
ALTER TABLE "TokenTopUpRequest" ADD CONSTRAINT "TokenTopUpRequest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
