// One-time bootstrap: creates (or updates) the first admin account from
// ADMIN_PASSWORD, so there's a way to log in and create further accounts
// from /admin. Run once per database:
//   npx tsx scripts/seed-admin.ts
import "dotenv/config";
import { PrismaClient } from "../lib/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { hashPassword } from "../lib/auth";

async function main() {
  const password = process.env.ADMIN_PASSWORD;
  if (!password) throw new Error("ADMIN_PASSWORD is not set");

  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
  const prisma = new PrismaClient({ adapter });

  const user = await prisma.user.upsert({
    where: { username: "admin" },
    update: {},
    create: { username: "admin", passwordHash: await hashPassword(password), role: "admin" },
    select: { id: true, username: true, role: true, createdAt: true },
  });

  console.log("Seeded admin user:", user);
  await prisma.$disconnect();
}

main();
