# Sammenskudsgilde

**Åbn appen her:** https://abusedwaffle.github.io/sammenskudsgilde/

Planlæg et sammenskudsgilde på telefonen: hvem tager hvad med, hvad sker der hvornår, og hvem skylder hvem bagefter. Ingen konto, ingen reklamer. Alle med linket ser det samme, og det opdateres live.

## Sådan opretter du et gilde
1. Åbn linket, skriv gildets **navn**, **dato**, **tidspunkt** og **sted** (og evt. en besked til gæsterne), og tryk **Opret gilde**.
2. Du får med det samme et **link og en QR-kode**. Send linket til gæsterne på SMS, Messenger eller lignende, eller lad dem scanne QR-koden. Du finder det altid igen under fanen **🔗 Del**.
3. Skriv dig selv på som gæst med navn og telefonnummer.
4. Del gildet op i punkter. Tryk fx **Forret + hovedret + dessert**, eller lav **programpunkter med tid** (14:00 Kaffe og kage, 18:00 Middag), eller dine egne punkter. Som vært kan du rette, flytte og slette punkterne og rette gildets detaljer (**✏️ Ret gildet**).

Telefonen, du oprettede gildet på, er husket som **vært 👑**.

Tip: Tryk på del-knappen i browseren og vælg **Føj til hjemmeskærm**, så ligger appen som et ikon på telefonen.

## Sådan kommer gæsterne med
1. Gæsten åbner linket (eller scanner QR-koden).
2. Skriver sit **navn** og **telefonnummer** og trykker **Tilmeld mig**. Så kan de andre se, hvem man er, og betale en tilbage via MobilePay.
3. Telefonen husker, hvem man er, næste gang linket åbnes. Låner man en andens telefon, trykker man **Jeg er ikke …** og tilmelder sig som ny person.

## Retter, aktiviteter og udgifter
- Under hvert punkt trykker man **+ Jeg tager noget med** og skriver, **hvad** man tager med (en ret, en aktivitet eller andet), **til hvor mange personer**, en evt. **note** (fx "vegetarisk") og evt. **hvad det kostede** i kr.
- En udgift kan deles mellem **alle deltagere** eller kun **udvalgte** (fx vin kun til dem, der drikker).
- Udgifter, der ikke hører til en ret (leje af lokale, vin, indkøb), tilføjes under fanen **💰 Regnskab** med **Tilføj en udgift**.
- Alle kan se, hvad de andre tager med. Man kan rette og slette sine egne ting med ✏️.

## Regnskab og MobilePay
Fanen **💰 Regnskab** viser:
- hvad der er brugt i alt,
- for hver person: hvad de har **betalt**, deres **andel** og deres **saldo** (plus = skal have penge, minus = skylder),
- **Hvem skylder hvem** med så få overførsler som muligt.

Beløb regnes præcist til øren. Går et beløb ikke lige op, får de første tilmeldte den ekstra øre.

Ved hver gæld står modtagerens **telefonnummer** og **beløbet** med knapperne **Kopiér nr.** og **Kopiér beløb**. Knappen **Åbn MobilePay** forsøger at åbne MobilePay med nummer og beløb udfyldt. MobilePay tilbyder ikke dette officielt, så sker der ikke noget, kopierer du bare nummer og beløb ind i MobilePay selv. Du kan også sende en SMS til modtageren.

## Det skal I være opmærksomme på
- **Linket er nøglen.** Alle, der har linket, kan se gæsternes navne og telefonnumre og skrive sig på. Del det kun med gæsterne. Gildet kan ikke findes på anden måde; linket er langt og tilfældigt.
- **Rettigheder hører til telefonen/browseren.** Rydder du browserdata, bruger privat vindue eller skifter telefon, kan du ikke længere rette dine gamle ting (de bliver stående).
- **Værts-linket:** Som vært finder du under **🔗 Del** et hemmeligt **værts-link**. Gem det (fx i en note til dig selv). Med det kan du rette og slette gildet fra en anden telefon eller efter at have ryddet browseren. Send det ikke til gæsterne.
- **Værten kan rette og slette alt** i gildet, også andres ting, og kan slette hele gildet under **✏️ Ret gildet**. Det kan ikke fortrydes.
- Alt gemmes online og opdateres live for alle, også når appen er lukket. Det kræver internet.

## Teknik (kort)
Statisk side på GitHub Pages med data i Google Firebase Firestore (EU, eur3) og anonymt Firebase-login. Konfigurationen står i `firebase-config.js`, og sikkerhedsreglerne i `firestore.rules` (skal indsættes i Firebase-konsollen under Firestore → Regler).
