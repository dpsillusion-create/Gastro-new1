/**
 * Einfache Verwaltung per Kommandozeile (bis es einen Admin-Bereich gibt).
 *   npx tsx scripts/admin.ts pending                       → unverifizierte Aushilfen auflisten
 *   npx tsx scripts/admin.ts verify <email> [BAR,SERVICE]  → Aushilfe freischalten (ohne Skills: angegebene übernehmen)
 *   npx tsx scripts/admin.ts unverify <email>              → Freischaltung entziehen
 * Benötigt DATABASE_URL (auf dem Server: `set -a; . /etc/smartshift.env; set +a`).
 */
import { PrismaClient, Skill } from '@prisma/client';
const prisma = new PrismaClient();
const [cmd, email, skills] = process.argv.slice(2);

async function main() {
  if (cmd === 'pending') {
    const list = await prisma.freelancer.findMany({ where: { verified: false }, include: { user: { select: { email: true } } }, orderBy: { createdAt: 'asc' } });
    for (const f of list) console.log(`${f.user.email}\t${f.displayName}\tangegeben: ${f.claimedSkills.join(',')}`);
    console.log(`${list.length} ausstehend`);
  } else if ((cmd === 'verify' || cmd === 'unverify') && email) {
    const f = await prisma.freelancer.findFirst({ where: { user: { email: email.toLowerCase() } } });
    if (!f) throw new Error('Aushilfe nicht gefunden');
    if (cmd === 'unverify') await prisma.freelancer.update({ where: { id: f.id }, data: { verified: false } });
    else {
      const list = skills ? (skills.split(',') as Skill[]) : f.claimedSkills;
      await prisma.freelancer.update({ where: { id: f.id }, data: { verified: true, verifiedSkills: list } });
      console.log(`freigeschaltet mit: ${list.join(',')}`);
    }
  } else console.log('Befehle: pending | verify <email> [SKILLS] | unverify <email>');
}
main().catch(e => { console.error(e.message); process.exit(1); }).finally(() => prisma.$disconnect());
