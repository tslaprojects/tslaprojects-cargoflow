import { buildActor, type Actor } from "@/lib/auth/actor";
import { hashPassword } from "@/lib/auth/password";
import { DEMO_CONTRACT_TEMPLATE, DEMO_TEMPLATE_CODE } from "@/lib/contracts/template";
import { prisma } from "@/lib/db/prisma";
import { loadInputSchema, type LoadInput } from "@/lib/validation/load";
import { DEFAULT_SETTINGS } from "@/server/services/settings.service";
import type { CompanyType, MemberRole } from "@/generated/prisma/enums";

export const PASSWORD = "Test12345";
const META = { ip: "10.0.0.1", userAgent: "vitest" };
let counter = 0;

/** Очищает базу текущего режима данных (по умолчанию — реальную; внутри runWithDataMode("demo") — демо-схему). */
export async function resetDb() {
  const tables = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = current_schema() AND tablename <> '_prisma_migrations'`;
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${tables.map((t) => `"${t.tablename}"`).join(", ")} RESTART IDENTITY CASCADE`);
  await prisma.platformSetting.createMany({
    data: Object.entries(DEFAULT_SETTINGS).map(([key, value]) => ({ key, value: value as never })),
  });
  await prisma.contractTemplate.create({ data: { code: DEMO_TEMPLATE_CODE, name: "Test", version: 1, body: DEMO_CONTRACT_TEMPLATE } });
}

let passwordHash: string | null = null;

export async function makeUser(opts: { role?: MemberRole; companyId?: string; admin?: boolean; name?: string } = {}) {
  counter += 1;
  passwordHash ??= await hashPassword(PASSWORD);
  const user = await prisma.user.create({
    data: {
      email: `user${counter}-${Date.now()}@test.local`,
      passwordHash,
      firstName: opts.name ?? `User${counter}`,
      lastName: "Test",
      phone: "+7 700 000 00 00",
      platformRole: opts.admin ? "PLATFORM_ADMIN" : "USER",
    },
  });
  if (opts.companyId && opts.role)
    await prisma.companyMember.create({ data: { companyId: opts.companyId, userId: user.id, role: opts.role } });
  return user;
}

export async function makeCompany(type: CompanyType, name?: string) {
  // Счётчик растёт при каждом вызове: иначе компании с явным именем, созданные в одну миллисекунду, получат одинаковый registrationNumber
  counter += 1;
  return prisma.company.create({
    data: {
      type,
      legalName: name ?? `${type} Co ${counter}`,
      registrationNumber: `REG-${counter}-${Date.now()}`,
      country: "KZ",
      city: "Алматы",
      address: "ул. Тестовая, 1",
      verificationStatus: "VERIFIED",
    },
  });
}

export async function actorFor(userId: string, companyId?: string): Promise<Actor> {
  return buildActor(userId, { activeCompanyId: companyId ?? null, meta: META });
}

/** Типовая сцена: грузовладелец, перевозчик (админ + водитель), машина, водитель. */
export async function scene() {
  const shipperCo = await makeCompany("SHIPPER", "Shipper LLP");
  const carrierCo = await makeCompany("CARRIER", "Carrier LLP");
  const carrier2Co = await makeCompany("CARRIER", "Carrier Two LLP");
  const shipperUser = await makeUser({ role: "SHIPPER", companyId: shipperCo.id });
  const carrierUser = await makeUser({ role: "CARRIER_ADMIN", companyId: carrierCo.id });
  const carrier2User = await makeUser({ role: "CARRIER_ADMIN", companyId: carrier2Co.id });
  const driverUser = await makeUser({ role: "DRIVER", companyId: carrierCo.id });
  const adminUser = await makeUser({ admin: true });
  const vehicle = await prisma.vehicle.create({
    data: {
      companyId: carrierCo.id,
      plateNumber: `KZ ${++counter} AB`,
      country: "KZ",
      make: "Volvo",
      model: "FH",
      vehicleType: "TRACTOR_TRAILER",
      bodyType: "CURTAINSIDER",
      capacityKg: 22000,
      gpsEnabled: true,
    },
  });
  const smallVehicle = await prisma.vehicle.create({
    data: {
      companyId: carrierCo.id,
      plateNumber: `KZ ${++counter} CD`,
      country: "KZ",
      make: "GAZ",
      model: "Next",
      vehicleType: "TRUCK",
      bodyType: "BOX",
      capacityKg: 5000,
    },
  });
  const driver = await prisma.driverProfile.create({
    data: {
      userId: driverUser.id,
      companyId: carrierCo.id,
      fullName: "Test Driver",
      phone: "+7 700 111 11 11",
      licenseNumber: "DL1",
      licenseCategory: "CE",
    },
  });
  return {
    shipperCo,
    carrierCo,
    carrier2Co,
    vehicle,
    smallVehicle,
    driver,
    shipper: await actorFor(shipperUser.id, shipperCo.id),
    carrier: await actorFor(carrierUser.id, carrierCo.id),
    carrier2: await actorFor(carrier2User.id, carrier2Co.id),
    driverActor: await actorFor(driverUser.id, carrierCo.id),
    admin: await actorFor(adminUser.id),
  };
}

export function loadInput(over: Partial<LoadInput> = {}) {
  const day = 24 * 60 * 60_000;
  return loadInputSchema.parse({
    title: "Электроника",
    cargoType: "ELECTRONICS",
    weightKg: 20000,
    priceType: "NEGOTIABLE",
    targetPrice: 4500,
    currency: "USD",
    bodyType: "CURTAINSIDER",
    stops: [
      { type: "PICKUP", country: "CN", city: "Урумчи", plannedDateFrom: new Date(Date.now() + 2 * day).toISOString() },
      { type: "TRANSIT", country: "KZ", city: "Алматы", plannedDateFrom: new Date(Date.now() + 4 * day).toISOString() },
      { type: "DELIVERY", country: "RU", city: "Москва", plannedDateFrom: new Date(Date.now() + 10 * day).toISOString() },
    ],
    ...over,
  });
}

export function pdfFile(name = "cmr.pdf") {
  return new File([new TextEncoder().encode("%PDF-1.4\n% test document\n%%EOF")], name, { type: "application/pdf" });
}

export async function expectAppError(p: Promise<unknown>, code: string) {
  try {
    await p;
  } catch (e) {
    const err = e as { code?: string; status?: number };
    if (err.code !== code) throw new Error(`Expected ${code}, got ${err.code}: ${(e as Error).message}`);
    return err;
  }
  throw new Error(`Expected AppError ${code}, but promise resolved`);
}
