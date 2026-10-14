# Duidelijk portaal en hulpvragen

**Actuele keuze: geen automatische mailing.** De geplande mailworkflow is verwijderd. Voorraadwaarschuwingen blijven onder Meldingen en hulpvragen blijven op het dashboard. De onderstaande mailinstructies zijn uitsluitend historische documentatie voor een eventuele latere heroverweging; voer ze niet uit. De ongebruikte mailfunctie en private tabellen zijn niet verwijderd.

Deze wijziging is voorbereid op `codex/duidelijk-portaal-meldingen`. Installatie op productie en publicatie vereisen afzonderlijke goedkeuring. Er worden geen accounts, rollen, pincodes of voorraadgegevens gewijzigd door de migratie.

## Vrijwilligers

Vier acties: **Tekort doorgeven**, **Verbruik registreren**, **Mijn account**, **Hulp vragen**. Start en afmelden blijven bereikbaar. Tellingen, uitlenen en terugbrengen zijn voortaan beheerdershandelingen, ook op de server. Camera en USB-scanner blijven beschikbaar in de verbruik- en tekortformulieren. Bij verbruik kan de koffer ook uit een lijst gekozen worden.

Hulpvragen worden eerst betrouwbaar opgeslagen en verschijnen in het beheerdersoverzicht; de vrijwilliger ziet alleen eigen vragen. Alleen een beheerder kan een vraag verwerken. Maximaal vijf nieuwe vragen per uur per gebruiker; veilige herhaling telt niet dubbel. Vermeld geen patiëntgegevens. Onder Instellingen vult een beheerder de naam, e-mail en telefoon van de verantwoordelijke in. Contactgegevens zijn bedoeld voor dringende hulp: automatische mail en beantwoording zijn niet onmiddellijk gegarandeerd.

## Wanneer wordt een mail verstuurd?

- Alle actieve beheerders met bevestigd e-mailadres ontvangen een melding per incident.
- Een lot met nog aanwezige voorraad en een vervaldatum vóór vandaag geldt als vervallen. Vandaag blijft geldig. De datum gebruikt `Europe/Brussels`.
- Een lege voorraad betekent: **geen bruikbaar, niet-vervallen materiaal op een relevante locatie**. Relevant is een koffer met een positieve gewenste hoeveelheid, of het magazijn bij een positieve minimumvoorraad of bestaande lotregistratie. Een nieuwe koffer zonder materiaallijst veroorzaakt geen legevoorraadmails voor alle producten.
- Iedere onbehandelde hulpvraag vormt een eigen incident.
- De geplande taak controleert ongeveer elke 15 minuten; GitHub kan taken vertragen. De website hoeft niet open te staan. Dit is geen noodalarmsysteem.
- Een blijvend incident wordt niet opnieuw verstuurd. Wanneer de controle vaststelt dat de voorraad weer aangevuld is en later opnieuw leeg raakt, ontstaat een nieuw incident. Kortstondige veranderingen tussen twee controles worden niet afzonderlijk geregistreerd.

## Veilige verzending

Een private SQL-wachtrij houdt per incident en beheerder de verzendstatus bij. Geen direct browserrecht op wachtrij of verzendfuncties. De worker vereist een aparte geheime taakcode van minimaal 32 tekens. De Supabase service key en Resend key blijven alleen op de server.

Een job krijgt een lease van vijf minuten en een vaste Resend idempotency key. Berichtinhoud en afleveradres blijven voor een retry identiek. Een onzekere verzending kan worden herhaald zonder een tweede mail binnen Resends idempotency-venster. Na maximaal acht pogingen of na 23 uur sinds de eerste poging wordt de job als mislukt gemarkeerd. Controleer zulke jobs handmatig; automatisch opnieuw aanmaken kan na het provider-venster dubbele mail veroorzaken. 'Verzonden' betekent door Resend geaccepteerd, niet aantoonbaar in de inbox afgeleverd. Bounces en spamfilters blijven mogelijk.

Jobs worden geannuleerd wanneer het incident bij de volgende controle opgelost is, het ontvangersadres verandert of de beheerder geen actieve beheerder meer is. Een al lopende externe verzending kan niet achteraf worden teruggehaald. Verzendfouten verschijnen als aantallen onder Instellingen en als mislukte GitHub-run; er worden geen sleutels of berichtinhouden gelogd.

## Installatie na goedkeuring

1. Maak een passende databaseback-up en installeer `supabase/migrations/20261014061123_volunteer_portal_notifications.sql`. Laat `material_private` buiten de exposed schemas. Oude tabellen blijven gesloten.
2. Maak een Resend-account en verifieer een afzenderdomein met de door Resend opgegeven DNS-records. Gebruik geen willekeurig onbevestigd afzenderadres. Deel de API-key niet in de chat of in GitHub-code.
3. Voeg in Supabase Edge Function Secrets toe: `RESEND_API_KEY`, `MATERIAL_MAIL_FROM` (bv. `Materiaalbeheer Nijlen <materiaal@jullie-gecontroleerde-domein.be>`) en `MATERIAL_MAIL_JOB_TOKEN` (willekeurige, sterke code van minimaal 32 tekens). Supabase levert zelf URL en service key aan de function.
4. Installeer de Edge Function `material-mail`, entrypoint `index.ts`, met beide bronbestanden. Gateway `verify_jwt=false`: de handler verifieert zelf de aparte geheime taakcode. Deze function accepteert geen vrijwilligerstokens als taakcode.
5. Stel dezelfde `MATERIAL_MAIL_JOB_TOKEN` in als GitHub Actions repository secret. Publiceer de goedgekeurde PR. De workflow gebruikt alleen de taakcode; geen Resend key of Supabase service key in GitHub. Zonder taakcode meldt hij expliciet dat mailing niet geactiveerd is.
6. Controleer dat GitHub Actions geplande workflows toestaat. Start de workflow eenmaal handmatig. Een succesvolle lege wachtrij bewijst bereikbaarheid, nog geen aflevering. Plan een expliciet goedgekeurde testmail naar een eigen beheerder; controleer Resend en de inbox. Maak daarvoor geen fictieve voorraad opnieuw aan zonder afspraak.
7. Vul contactgegevens in via Instellingen. Controleer de hulpvraagroute en de actuele wachtrijstatus. De gewone Supabase uitnodigings- en PIN-herstelmails blijven via Supabase werken.

De server verstuurt geen mail wanneer Resend-configuratie ontbreekt. Voorraadsignalering en hulpvragen in de website blijven bruikbaar; daadwerkelijke automatische mails vereisen alle configuratiestappen.

## Validatie en grenzen

Automatische tests gebruiken fictieve gegevens op een lokale PostgreSQL 17-database met echte pg-safeupdate, Chromium en gesimuleerde Supabase Auth. Mailprovider en netwerkfalen worden gesimuleerd; er zijn tijdens ontwikkeling geen echte mails verstuurd. De tests controleren rollen, SQL-rechten, hulpvraagvalidatie/privacy, request-herhaling, incidentdeduplicatie, lege/expired voorraad, leases en foutafhandeling. Layout wordt op desktop- en mobiele breedtes gecontroleerd. Echte fysieke smartphones, USB-scanners en Resend-inboxaflevering zijn geen gevolgtrekking uit deze tests.
