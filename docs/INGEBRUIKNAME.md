# Ingebruikname na beoordeling

Er is geen productie-deploy gedaan. `main` is niet gewijzigd. Bestaande Supabase-gebruikers en gegevens zijn niet veranderd. Geen van onderstaande productiestappen is uitgevoerd.

## Wat zonder productie-ingrepen getest is

De versie-2-migratie, Auth-/ledencontrole, RLS/rechten, servervalidatie, transacties, concurrency, loten, uitleningen, back-ups en de goedkeuringsblokkade voor cutover zijn getest op een lokale PostgreSQL 17-database met fictieve gebruikers. De interface is getest in Chromium tegen die database met gesimuleerde Auth HTTP-antwoorden.

Een apart Supabase-testproject moet worden gebruikt voor volledige acceptatie. Gebruik nooit de automatische DB-testbootstrap op een Supabase-project: deze maakt fictieve Auth-tabellen en reset de lokale testschema’s.

## Gevolgen voor andere toepassingen

Bij alleen-lezen inspectie van productie zijn acht oude publieke tabellen gevonden: `app_state`, `categories`, `locations`, `products`, `cases`, `lots`, `loans` en `moves`. Er zijn interne foreign keys van `loans` naar `cases`, van `lots`/`moves` naar `products`, en van `products` naar `categories`. Er waren geen publieke views of functies; de latere controle vond geen niet-interne publieke triggers en geen externe foreign keys naar de publieke tabellen.

Dit bewijst niet dat geen andere website, script of externe toepassing de oude REST-tabellen gebruikt. Vraag de projectbeheerder welke toepassingen hetzelfde project gebruiken en controleer recente API-logs. `supabase/preflight.sql` levert een opnieuw uitvoerbare, alleen-lezen controle op.

De nieuwe migratie maakt uitsluitend een apart `material_private`-schema en twee `public.material_*` RPC-wrappers. Zij wijzigt of verwijdert geen oude tabellen, Auth-accounts of rollen in Auth. De afzonderlijke **cutover trekt rechten op alle acht oude tabellen in**; dit sluit de oude website en eventuele andere afnemers van die tabellen af. Die wijziging vereist expliciete goedkeuring.

## Stappenplan

1. **Beoordeel de Pull Request en houd automatische productie-deploys uitgeschakeld.** Ook het later samenvoegen van de PR kan bij bestaande Netlify-integraties automatisch deployen; controleer dit vóór merge. De toegevoegde GitHub-workflow voert alleen tests uit.
2. **Maak een volledige databaseback-up.** Hoewel de voorraad fictief is, blijven gebruikers en eventuele andere toepassingen belangrijk. Bewaar schema, grants/policies en data voor herstel. Controleer andere afnemers met de preflight en projectbeheerder.
3. **Installeer en accepteer op een apart Supabase-testproject.** Voer `supabase/migrations/*material_management_v2.sql` uit. `material_private` mag niet worden toegevoegd aan exposed schemas; houd alleen de publieke RPCs bereikbaar. Gebruik eigen fictieve testaccounts in dat testproject en controleer admin, volunteer, niet-lid en anoniem via echte Supabase Auth/Data API.
4. **Configureer accounts en publicatiebeleid in het testproject.** Publieke registratie en anonymous sign-ins uitschakelen; persoonlijke accounts met sterke wachtwoorden, beheerders bij voorkeur MFA. Pas bestaande productieaccounts niet aan zonder toestemming. Met `provision_members.sql` worden uitsluitend expliciet goedgekeurde bestaande account-UUIDs aan de applicatie gekoppeld.
5. **Doe praktijktests.** Windows/Edge of Chrome met AZERTY/QWERTY USB-scanner; Android/Chrome; iPhone/Safari; toestemmingen weigeren/herstellen; geen achtercamera; camera sluiten tijdens starten; schermvergrendeling; meerdere apparaten; A4-labels en inventarislijsten.
6. **Vraag expliciete goedkeuring voor de concrete productie-cutover en publicatie.** Benoem welke oude tabellen worden afgesloten, welke accounts lidmaatschap krijgen en welke siteversie wordt gepubliceerd. Een test of PR is geen toestemming voor productie.
7. **Voer na goedkeuring de gecontroleerde installatie uit.** Installeer de migratie op productie en koppel goedgekeurde bestaande account-UUIDs met rol `admin`/`volunteer`. Deze tabellen worden initieel leeg aangemaakt; maak een magazijnlocatie, producten en koffers aan, of importeer een gecontroleerde versie-2-voorraadback-up. Auth-gebruikers worden niet aangemaakt, verwijderd of gewijzigd door de SQL.
8. **Sluit oude toegang bij de afgesproken cutover.** Na expliciete toestemming mag in dezelfde SQL-uitvoering `set material.approved_legacy_cutover = 'yes';` gevolgd door `production_cutover.sql` worden uitgevoerd. Zonder deze instelling weigert het script. Er worden geen oude tabellen, voorraadrecords of Auth-gebruikers verwijderd.
9. **Publiceer de goedgekeurde build.** `npm ci`, stel uitsluitend de productie-URL en publishable key in, `npm run build`, publiceer de volledige `dist/` inclusief `_headers`. Geen `service_role`/secret key gebruiken. Upload niet alleen de bron-HTML.
10. **Controleer en monitor.** Anoniem/niet-lid moeten geen v2-voorraad kunnen lezen of schrijven; de oude tabellen moeten via REST gesloten zijn. Controleer echte tokenvernieuwing, rolverandering, gelijktijdig verbruik, verloren antwoord + veilige retry, retour, back-upherstel, CSP-headers en Supabase advisors.

## Herstel bij ingebruiknameproblemen

De migratie en cutover zijn transactioneel. Een SQL-fout rolt de betreffende uitvoering terug. Bewaar de volledige voorafgaande databaseback-up en het policy/grants-overzicht.

Zet bij problemen het nieuwe gebruik tijdelijk stil en herstel vanuit de gecontroleerde back-up. Zet de oude onbeperkte anonieme policies niet terug als noodoplossing: daarmee wordt het bekende beveiligingslek heropend. Het verwijderde oude PIN-systeem is geen veilige fallback.

## Back-ups en persoonsgegevens

Een voorraadexport bevat catalogus, locaties, targets en loten. Historiek/uitleningen/tekorten hebben een afzonderlijke adminexport. Herstel bewaart bestaande auditgegevens en verandert geen historische lotidentiteiten. Open uitleningen moeten eerst worden teruggebracht. Bewaar volledige Supabase-back-ups voor disaster recovery en bepaal een bewaartermijn voor persoonsgegevens samen met de afdeling; die organisatorische termijn kan de code niet vaststellen.

De offline converter voor oude JSON maakt geldige v2-voorraad en een apart historiekbestand. Oude uitleningen met vrije omschrijving kunnen niet betrouwbaar automatisch worden gekoppeld; controleer deze fysiek. Oude PIN/gebruikersmodus wordt niet meegenomen naar de nieuwe voorraad.
