# Herstel van de technische audit

Branch: `codex/volledig-herstel`. Basis: `8b5cf9cfe5a5afaba5a596c7e513c4005ede4a2c`.

De wijzigingen zijn geïmplementeerd en lokaal getest. De bestaande live site en Supabase-database zijn niet gewijzigd. K1–K3 blijven dus van toepassing op de oude live omgeving totdat de expliciet goedgekeurde ingebruikname is afgerond.

## Kritieke punten

| Punt | Herstel | Bewijs / status |
| --- | --- | --- |
| K1 Onbeperkte anonieme database | Aparte `material_private`-tabellen met RLS, geen directe clientrechten, gecontroleerde RPCs. `production_cutover.sql` trekt ook de oude tabelrechten in. | Rollen- en privilege-tests op PostgreSQL 17. Oude productierechten sluiten vereist aparte goedkeuring. |
| K2 Ontbrekende productiebeveiliging | Volledige versie-2-migratie en afzonderlijk lidmaatschapsbestand. Oude `security.sql` weigert uitvoering om verkeerd installeren te voorkomen. | Migratie wordt bij iedere DB-test vanaf nul uitgevoerd. Nog niet op productie geïnstalleerd. |
| K3 Gedeelde toegang / lokale rollen | Persoonlijke Supabase Auth, serverafgeleid lidmaatschap en sessiecontrole. Geen gedeelde PIN of persistent toegangstoken. Oude browsercache wordt verwijderd. | Anoniem, niet-lid, admin en vrijwilliger getest; huidige productie-HTML blijft ongewijzigd. |
| K4 Gelijktijdig gegevensverlies | Gerichte transacties met database-lock en idempotente request-IDs; geen volledige JSON-statewrites. | Twee onafhankelijke verbindingen en twee browseraccounts getest; 20 gelijktijdige aanvullingen tellen op. |
| K5 Negatief verbruik | Gehele positieve aantallen op client én server, voorraadconstraints. | Negatief, nul, fractioneel, tekst, null en te groot servermatig geweigerd. |
| K6 Lotverlies bij telling | Telling per lot met lotversie; lotnummer/vervaldatum blijven onveranderlijke identiteit. | Telling, verschillende vervaldatums en atomische rollback getest. |
| K7 JavaScript-injectie | Geen inline handlers, escaped HTML, geen JSON in uitvoerbare attributen, volledige getalvalidatie, CSP, lokale bibliotheken. | Browser voert kwaadaardig ogende productnaam/code niet uit; ongeldige lothoeveelheden geweigerd. |
| K8 Oude taak onder nieuw account | Geen gedeelde opslagwachtrij. Epoch-, user- en tokenguards; abort bij afmelden; maximaal één actieve opdracht. | Accountwisseling tijdens refresh en tijdens RPC, oude antwoorden en oude retries getest. |

## Functionele punten

| Punt | Herstel en verantwoordelijke onderdelen |
| --- | --- |
| F1 Categorie wordt niet opgeslagen | `src/app.js` catalogusformulier en SQL `catalog`: `category_id` wordt bewaard. |
| F2 Negatieve minimumvoorraad | `whole()` en integerconstraint op `products.minimum`. |
| F3 Ongeldige aantallen | `whole()` op formulieren, SQL `whole()` en tabelconstraints voor voorraad, telling, tekorten, uitlenen en retour. |
| F4 Voorraad zonder product | Foreign keys en servercontrole van actieve producten/locaties. |
| F5 Vervallen lot verbruiken | FEFO-transactie gebruikt alleen loten met geldige Belgische kalenderdatum; vervallen retouren blijven bij hun oorspronkelijke lot. |
| F6 Tekortknop crasht | Tekortpagina wordt met geselecteerde koffer geopend; geen ontbrekende DOM-container. |
| F7 Vrijwilligersscan geblokkeerd | Scanner staat expliciet in vrijwilligersnavigatie en toegestane pagina’s. |
| F8 Meldingen voor onbedoelde producten | Koffermeldingen uitsluitend op materiaallijst; gewenste hoeveelheid per koffer. |
| F9 Meldingen blijven permanent weg | Verwerking hoort bij een concrete fingerprint van versies/hoeveelheid; nieuwe toestand activeert nieuwe melding. |
| F10 Gemeld tekort ontbreekt op aanvullijst | Aanvulling is maximum van berekend en gemeld tekort; herhaalde meldingen worden niet opgeteld. |
| F11 Opgelost zonder fysieke handeling | Beheerder geeft uitgevoerde oplossing op. Voorraadwijziging blijft een afzonderlijke expliciete transactie; UI legt dit uit en registreert wie de melding verwerkte. |
| F12 Uitlenen los van voorraad | `loans` + `loan_lines` koppelen uitleningen aan loten; FEFO-afboeking, gedeeltelijke retour, bescherming tegen te veel retour. |
| F13 Verkeerde scanmatch | Exacte match eerst; genormaliseerde uniciteit in SQL, ook tussen producten en koffers. |
| F14 Losse kofferconfiguratie na verwijderen | Archiveren verwijdert targets en behoudt historische productidentiteit. Niet mogelijk bij voorraad/open uitleningen/open tekort. |
| F15 Afdruk zonder lotgegevens | Inventaris drukt ieder lot, aantal en vervaldatum af; ingestelde producten zonder lot krijgen een nulregel. |
| F16 Te vroege succesmelding | Pas `saved:true` toont Opgeslagen; fout of onzeker antwoord heeft aparte status en veilige retry. |
| F17 Onvolledige historiek | Historiek toont datum, handeling, product, locatie, getekend aantal, lot, vervaldatum en gebruiker. Mutaties zijn niet wijzigbaar via clientrechten. |

## Aanvullende punten

- Synchronisatie om de 15 seconden en bij terugkeer/online gaan. Invoer wordt niet overschreven; lot- en catalogusversies weigeren verouderde correcties.
- Supabase SDK vernieuwt toegangstokens. Rollen, lidmaatschap en bestaande Auth-sessie worden servermatig gecontroleerd; gewijzigde rollen vragen opnieuw aanmelden.
- Time-outs, netwerkuitval en gatewayfouten behouden een herhaalbaar verzoek. Herhaling met hetzelfde ID kan niet opnieuw voorraad wijzigen. Zonder bevestiging blijft een waarschuwing zichtbaar.
- Camera gebruikt lokaal gebundelde scannerbibliotheek. Eén lifecycle voor starten, sluiten, navigeren, afmelden en verbergen; achtercamerafallback zonder ontbrekende video-elementen.
- USB-listener negeert loginvelden, gewone tekstvelden, tekstareas, modifiers en verouderde buffers. Kofferscans behouden de tekort-/controleflow.
- QR en Code128 worden lokaal gegenereerd, ook voor afdrukken; codes gaan niet meer naar externe labeldiensten.
- Back-upversie 2 valideert arrays, integerwaarden, unieke IDs en relaties op client en server. Herstel vereist actuele revisie en geen open uitleningen; oude mutaties worden nooit herschreven.
- Oude voorraadback-ups kunnen offline worden geconverteerd. Oude vrije-tekstuitleningen/historiek worden apart gearchiveerd, zonder verzonnen relaties.
- Vrijwilligers zien geen volledige mutatiehistoriek en geen persoonsgegevens/notities van andere vrijwilligers. Admins hebben aparte archiefexport.
- Lokale kalenderdatums in Europe/Brussels; geen UTC-datumverschuiving bij vervalcontrole.
- NPM-versies en lockfile vastgelegd, lokaal gebundelde assets, CSP, no-referrer, camera-permission en nosniff-headers.

## Bewuste beperkingen

- Er wordt nog niet beweerd dat productie veilig is: de cutover is voorbereid, maar niet uitgevoerd.
- De browser-Auth-testserver simuleert Supabase Auth HTTP-antwoorden. Database-RPCs zijn echt PostgreSQL; volledige acceptatie tegen een apart Supabase-project volgt vóór productie.
- Fysieke apparaten, cameraoptiek, USB-hardware en printeruitvoer vereisen praktijktests.
- Sessies blijven in geheugen. Een herladen pagina vraagt opnieuw aanmelden. Bij onzeker opslaan waarschuwt de browser vóór verlaten; na bewust verlaten moet de historiek worden gecontroleerd voordat men opnieuw registreert.
- Een voorraadback-up is geen volledige disaster-recoveryback-up. Gebruik daarnaast een volledige Supabase-databaseback-up.
