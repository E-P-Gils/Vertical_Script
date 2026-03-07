/**
 * Name engine: mix-and-match first/last names for characters,
 * plus billionaire/werewolf family names.
 * All names sourced from the provided character list.
 */

const FULL_NAMES = [
  "Ethan Carter", "Liam Brooks", "Noah Bennett", "Mason Hayes", "Lucas Turner",
  "Oliver Grant", "Elijah Ross", "Jameson Blake", "Logan Pierce", "Aiden Shaw",
  "Caleb Stone", "Wyatt Hunter", "Julian Drake", "Nathan Cross", "Connor Vale",
  "Sebastian Cole", "Dylan Hart", "Carter Rhodes", "Hunter Knox", "Ryan Mercer",
  "Brandon Wells", "Zachary Chase", "Jordan Steele", "Austin Ford", "Trevor Kane",
  "Garrett Hale", "Maxwell Crane", "Dominic Voss", "Adrian Locke", "Tristan Wolfe",
  "Victor Hale", "Alexander Frost", "Eric Dalton", "Matthew Hayes", "Daniel Cross",
  "Nicholas Ward", "Samuel Kane", "Jonathan Drake", "Owen Steele", "Isaac Ford",
  "Blake Mercer", "Riley Stone", "Gavin Rhodes", "Colin Hart", "Parker Shaw",
  "Evan Bennett", "Tyler Knox", "Jason Pierce", "Cole Hunter", "Miles Grant",
  "Ava Sinclair", "Olivia Monroe", "Emma Caldwell", "Sophia Bennett", "Isabella Drake",
  "Mia Carter", "Charlotte Hayes", "Amelia Brooks", "Harper Blake", "Evelyn Ross",
  "Abigail Shaw", "Scarlett Turner", "Lily Grant", "Chloe Mercer", "Grace Hunter",
  "Ella Rhodes", "Victoria Wells", "Madison Stone", "Hannah Cross", "Zoey Pierce",
  "Natalie Vale", "Audrey Steele", "Claire Dalton", "Stella Ford", "Ruby Kane",
  "Ivy Wolfe", "Lillian Hart", "Sadie Bennett", "Lucy Hale", "Naomi Drake",
  "Aurora Chase", "Aria Monroe", "Brielle Grant", "Delilah Carter", "Eliza Shaw",
  "Fiona Rhodes", "Gemma Steele", "Hazel Pierce", "Iris Vale", "Jade Mercer",
  "Kira Blake", "Leila Ross", "Mira Knox", "Nina Wells", "Ophelia Cross",
  "Paige Dalton", "Quinn Hayes", "Rhea Turner", "Sienna Ford", "Tessa Wolfe",
  "Derek Vaughn", "Marcus Sloan", "Victor Holloway", "Adrian Maddox", "Damien Crawford",
  "Leonard Bishop", "Patrick Doyle", "Vincent Navarro", "Oscar Delgado", "Hugo Castillo",
  "Ruben Alvarez", "Cesar Montoya", "Mateo Rivera", "Diego Salazar", "Rafael Ortega",
  "Santiago Cortez", "Javier Morales", "Emilio Vargas", "Andres Dominguez", "Luis Herrera",
  "Bianca Alvarez", "Camila Ortega", "Daniela Rivera", "Elena Castillo", "Gabriela Salazar",
  "Isabella Navarro", "Julieta Morales", "Karina Delgado", "Lucia Cortez", "Mariana Vargas",
  "Natalia Montoya", "Paloma Herrera", "Renata Dominguez", "Sofia Andrade", "Valeria Rojas",
  "Ximena Duarte", "Yasmin Calderon", "Zara Mendoza", "Adriana Figueroa", "Beatriz Navarro",
  "Kai Nakamura", "Hiro Tanaka", "Kenji Sato", "Ren Ishikawa", "Daichi Mori",
  "Haruto Takahashi", "Taro Fujimoto", "Yuto Kuroda", "Akira Yamamoto", "Riku Watanabe",
  "Mei Chen", "Lian Zhang", "Xia Lin", "Yan Wu", "Jia Huang", "Ning Zhao",
  "Qian Liu", "Rui Sun", "Shan Gao", "Yue Deng",
  "Theo Whitmore", "Alistair Grant", "Benedict Clarke", "Cedric Hawthorne", "Dominic Ashcroft",
  "Edmund Fletcher", "Frederick Caldwell", "Gregory Whitaker", "Harrison Pembroke", "Laurence Beaumont",
  "Arabella Whitmore", "Beatrice Ashcroft", "Celeste Hawthorne", "Daphne Caldwell", "Eleanor Pembroke",
  "Felicity Beaumont", "Georgina Whitaker", "Helena Fletcher", "Isadora Clarke", "Josephine Grant",
  "Rowan Black", "Axel Storm", "Jace Night", "Zane Wilder", "Ryker Vale",
  "Knox Archer", "Blaise Raven", "Orion Vance", "Phoenix Drake", "Dante Crow",
  "Nova Winters", "Skye Rivers", "Luna Ash", "Aria Storm", "Ember Frost",
  "Willow Hart", "Raven Locke", "Sage Wilder", "Indigo Vale", "Lyra Crow",
  "Preston York", "Malcolm Archer", "Quentin Blake", "Randall Pierce", "Spencer Grant",
  "Theodore Wells", "Wallace Hunter", "Xavier Stone", "Yale Mercer", "Zachariah Cross",
  "Adelaide Pierce", "Bridget York", "Cassandra Wells", "Diana Archer", "Estelle Grant",
  "Francesca Blake", "Giselle Stone", "Helena Mercer", "Imogen Cross", "Juliet Hunter",
  "Leo Bennett", "Arlo Carter", "Milo Turner", "Jude Brooks", "Ezra Hayes",
  "Nico Shaw", "Felix Grant", "Otto Mercer", "Roman Drake", "Silas Pierce",
  "Cleo Monroe", "Esme Sinclair", "Freya Caldwell", "Gia Bennett", "Harlow Drake",
  "Indie Carter", "Juno Hayes", "Kaia Brooks", "Lila Shaw", "Mabel Grant",
  "Victor Kane", "Leon Voss", "Stefan Wolfe", "Ivan Petrov", "Nikolai Sokolov",
  "Pavel Morozov", "Anton Dragunov", "Sergei Volkov", "Dimitri Kozlov", "Mikhail Romanov",
  "Anya Volkov", "Katya Morozova", "Nadia Petrov", "Olga Sokolova", "Irina Kozlova",
  "Svetlana Romanova", "Tatiana Dragunova", "Yelena Ivanova", "Marina Pavlova", "Vera Orlova",
  "Chase Donovan", "Grant Callahan", "Luke Calloway", "Brady Whitman", "Cody Langston",
  "Blake Easton", "Drew Maddox", "Shane Walker", "Troy Bennett", "Wade Foster",
  "Amber Langston", "Brooke Donovan", "Cassidy Whitman", "Dakota Walker", "Eden Foster",
  "Faith Callahan", "Hope Maddox", "Joy Easton", "Kennedy Bennett", "London Calloway",
  "Alec Thorn", "Brett Hollow", "Colin Stroud", "Dean Hawke", "Ellis Ward",
  "Finn Archer", "Gray Holden", "Heath Calder", "Ian Mercer", "Jack Holloway",
  "Alice Calder", "Bethany Ward", "Cora Holden", "Daisy Archer", "Elise Thorn",
  "Flora Stroud", "Greta Holloway", "Holly Mercer", "Isla Hawke", "June Hollow",
];

// Parse full names into first/last; classify by gender for archetypes.
const FIRST_MALE = [
  "Ethan", "Liam", "Noah", "Mason", "Lucas", "Oliver", "Elijah", "Jameson", "Logan", "Aiden",
  "Caleb", "Wyatt", "Julian", "Nathan", "Connor", "Sebastian", "Dylan", "Carter", "Hunter", "Ryan",
  "Brandon", "Zachary", "Jordan", "Austin", "Trevor", "Garrett", "Maxwell", "Dominic", "Adrian", "Tristan",
  "Victor", "Alexander", "Eric", "Matthew", "Daniel", "Nicholas", "Samuel", "Jonathan", "Owen", "Isaac",
  "Blake", "Riley", "Gavin", "Colin", "Parker", "Evan", "Tyler", "Jason", "Cole", "Miles",
  "Derek", "Marcus", "Damien", "Leonard", "Patrick", "Vincent", "Oscar", "Hugo", "Ruben", "Cesar",
  "Mateo", "Diego", "Rafael", "Santiago", "Javier", "Emilio", "Andres", "Luis",
  "Kai", "Hiro", "Kenji", "Ren", "Daichi", "Haruto", "Taro", "Yuto", "Akira", "Riku",
  "Theo", "Alistair", "Benedict", "Cedric", "Edmund", "Frederick", "Gregory", "Harrison", "Laurence",
  "Rowan", "Axel", "Jace", "Zane", "Ryker", "Knox", "Blaise", "Orion", "Phoenix", "Dante",
  "Preston", "Malcolm", "Quentin", "Randall", "Spencer", "Theodore", "Wallace", "Xavier", "Yale", "Zachariah",
  "Leo", "Arlo", "Milo", "Jude", "Ezra", "Nico", "Felix", "Otto", "Roman", "Silas",
  "Leon", "Stefan", "Ivan", "Nikolai", "Pavel", "Anton", "Sergei", "Dimitri", "Mikhail",
  "Chase", "Grant", "Luke", "Brady", "Cody", "Drew", "Shane", "Troy", "Wade",
  "Alec", "Brett", "Dean", "Ellis", "Finn", "Gray", "Heath", "Ian", "Jack",
];

const FIRST_FEMALE = [
  "Ava", "Olivia", "Emma", "Sophia", "Isabella", "Mia", "Charlotte", "Amelia", "Harper", "Evelyn",
  "Abigail", "Scarlett", "Lily", "Chloe", "Grace", "Ella", "Victoria", "Madison", "Hannah", "Zoey",
  "Natalie", "Audrey", "Claire", "Stella", "Ruby", "Ivy", "Lillian", "Sadie", "Lucy", "Naomi",
  "Aurora", "Aria", "Brielle", "Delilah", "Eliza", "Fiona", "Gemma", "Hazel", "Iris", "Jade",
  "Kira", "Leila", "Mira", "Nina", "Ophelia", "Paige", "Quinn", "Rhea", "Sienna", "Tessa",
  "Bianca", "Camila", "Daniela", "Elena", "Gabriela", "Julieta", "Karina", "Lucia", "Mariana", "Natalia",
  "Paloma", "Renata", "Sofia", "Valeria", "Ximena", "Yasmin", "Zara", "Adriana", "Beatriz",
  "Mei", "Lian", "Xia", "Yan", "Jia", "Ning", "Qian", "Rui", "Shan", "Yue",
  "Arabella", "Beatrice", "Celeste", "Daphne", "Eleanor", "Felicity", "Georgina", "Helena", "Isadora", "Josephine",
  "Nova", "Skye", "Luna", "Ember", "Willow", "Raven", "Sage", "Indigo", "Lyra",
  "Adelaide", "Bridget", "Cassandra", "Diana", "Estelle", "Francesca", "Giselle", "Imogen", "Juliet",
  "Cleo", "Esme", "Freya", "Gia", "Harlow", "Indie", "Juno", "Kaia", "Lila", "Mabel",
  "Anya", "Katya", "Nadia", "Olga", "Irina", "Svetlana", "Tatiana", "Yelena", "Marina", "Vera",
  "Amber", "Brooke", "Cassidy", "Dakota", "Eden", "Faith", "Hope", "Joy", "Kennedy", "London",
  "Alice", "Bethany", "Cora", "Daisy", "Elise", "Flora", "Greta", "Holly", "Isla", "June",
];

const LAST_NAMES = [
  "Carter", "Brooks", "Bennett", "Hayes", "Turner", "Grant", "Ross", "Blake", "Pierce", "Shaw",
  "Stone", "Hunter", "Drake", "Cross", "Vale", "Cole", "Rhodes", "Knox", "Mercer", "Wells",
  "Chase", "Steele", "Ford", "Kane", "Hale", "Crane", "Voss", "Locke", "Wolfe", "Frost",
  "Dalton", "Ward", "Sinclair", "Monroe", "Caldwell", "Vaughn", "Sloan", "Holloway", "Maddox", "Crawford",
  "Bishop", "Doyle", "Navarro", "Delgado", "Castillo", "Alvarez", "Montoya", "Rivera", "Salazar", "Ortega",
  "Cortez", "Morales", "Vargas", "Dominguez", "Herrera", "Andrade", "Rojas", "Duarte", "Calderon", "Mendoza",
  "Figueroa", "Nakamura", "Tanaka", "Sato", "Ishikawa", "Mori", "Takahashi", "Fujimoto", "Kuroda", "Yamamoto", "Watanabe",
  "Chen", "Zhang", "Lin", "Wu", "Huang", "Zhao", "Liu", "Sun", "Gao", "Deng",
  "Whitmore", "Ashcroft", "Hawthorne", "Clarke", "Fletcher", "Pembroke", "Beaumont", "Whitaker",
  "Black", "Storm", "Night", "Wilder", "Archer", "Raven", "Vance", "Crow", "Winters", "Rivers", "Ash",
  "York", "Wells", "Hunter", "Stone", "Mercer", "Cross", "Petrov", "Sokolov", "Morozov", "Dragunov",
  "Volkov", "Kozlov", "Romanov", "Morozova", "Sokolova", "Kozlova", "Romanova", "Dragunova", "Ivanova", "Pavlova", "Orlova",
  "Donovan", "Callahan", "Calloway", "Whitman", "Langston", "Easton", "Walker", "Foster", "Bennett",
  "Thorn", "Hollow", "Stroud", "Hawke", "Holden", "Calder", "Mercer", "Holloway", "Ward",
];

// Billionaire / werewolf family names (dynasty-style).
const FAMILY_NAMES = [
  "Whitmore", "Ashcroft", "Holloway", "Hawthorne", "Pembroke", "Beaumont", "Blackwood",
  "Storm", "Raven", "Vance", "Black", "Crane", "Locke", "Frost", "Vale",
  "Romanov", "Volkov", "Sokolov", "Whitmore", "Grant", "Clarke", "Hawthorne",
  "Callahan", "Donovan", "Hollow", "Stroud", "Hawke", "Archer", "Winters",
];

// Werewolf pack names (300) — used when genre is WEREWOLF.
const WEREWOLF_PACK_NAMES = [
  "Shadowfang Pack", "Black Moon Pack", "Nightclaw Pack", "Obsidian Fang Pack", "Midnight Howl Pack",
  "Darkwood Pack", "Eclipse Pack", "Ravenfang Pack", "Nightshade Pack", "Phantom Howl Pack",
  "Blood Moon Pack", "Blackthorn Pack", "Duskfang Pack", "Dark Howl Pack", "Shadowclaw Pack",
  "Moonshadow Pack", "Twilight Fang Pack", "Umbral Pack", "Nocturne Pack", "Voidfang Pack",
  "Black Wolf Pack", "Silent Moon Pack", "Ghostclaw Pack", "Darkfang Pack", "Abyss Howl Pack",
  "Nightveil Pack", "Obsidian Moon Pack", "Black Ember Pack", "Dreadfang Pack", "Phantom Fang Pack",
  "Silver Moon Pack", "Lunar Fang Pack", "Crescent Moon Pack", "Moonlight Pack", "Full Moon Pack",
  "Frost Moon Pack", "Crimson Moon Pack", "Winter Moon Pack", "Harvest Moon Pack", "Pale Moon Pack",
  "Moonrise Pack", "Moonfire Pack", "Moonfang Pack", "Moonveil Pack", "Moonshadow Pack",
  "Mooncrest Pack", "Moonwolf Pack", "Moonwatch Pack", "Moonhunter Pack", "Moonhowl Pack",
  "Moonreign Pack", "Moonspire Pack", "Moonthorn Pack", "Moonstorm Pack", "Moondrift Pack",
  "Moonblood Pack", "Moonkeeper Pack", "Moonward Pack", "Moonforge Pack", "Moonwarden Pack",
  "Ironwood Pack", "Wildwood Pack", "Pineclaw Pack", "Redwood Pack", "Stonepine Pack",
  "Frostpine Pack", "Oakfang Pack", "Wolfpine Pack", "Cedarclaw Pack", "Wolfwood Pack",
  "Thornwood Pack", "Ashwood Pack", "Frostwood Pack", "Stormwood Pack", "Shadowwood Pack",
  "Wolfgrove Pack", "Mistwood Pack", "Pinehowl Pack", "Thornfang Pack", "Ironpine Pack",
  "Stonefang Pack", "Frostfang Pack", "Cedarhowl Pack", "Thornhowl Pack", "Wolfthorn Pack",
  "Ravenwood Pack", "Silverwood Pack", "Darkpine Pack", "Ghostwood Pack", "Bloodwood Pack",
  "Ironfang Pack", "Bloodfang Pack", "Warfang Pack", "Steelclaw Pack", "Ironclaw Pack",
  "Savage Fang Pack", "Warhowl Pack", "Battleclaw Pack", "Stormfang Pack", "Thunderclaw Pack",
  "Ragefang Pack", "Warborn Pack", "Ironwolf Pack", "Bloodclaw Pack", "Crimson Fang Pack",
  "Stormhowl Pack", "Ironstorm Pack", "Warstorm Pack", "Thunderfang Pack", "Warshadow Pack",
  "Bloodstorm Pack", "Fangstorm Pack", "Ironreign Pack", "Warcrest Pack", "Savageclaw Pack",
  "Stormreign Pack", "Ironhunt Pack", "Warhunt Pack", "Bloodhunt Pack", "Stormhunt Pack",
  "Silverfang Pack", "Golden Fang Pack", "Crownfang Pack", "Royal Moon Pack", "Highfang Pack",
  "Sovereign Fang Pack", "Regal Moon Pack", "Iron Crown Pack", "Moon Crown Pack", "Lunar Throne Pack",
  "Alpha Crown Pack", "Moon Throne Pack", "High Moon Pack", "Silver Crown Pack", "Noble Fang Pack",
  "Crownclaw Pack", "Thronefang Pack", "Moon Sovereign Pack", "Royal Howl Pack", "Crown Moon Pack",
  "Noble Moon Pack", "Regal Fang Pack", "Silver Throne Pack", "Moon Dynasty Pack", "Alpha Dynasty Pack",
  "Lunar Crown Pack", "Crown Howl Pack", "Moon Regent Pack", "Alpha Regent Pack", "Silver Regent Pack",
  "Frostfang Pack", "Glacier Fang Pack", "Iceclaw Pack", "Winterfang Pack", "Snowhowl Pack",
  "Icehowl Pack", "Frostclaw Pack", "Winterclaw Pack", "Snowfang Pack", "Glacierclaw Pack",
  "Icewolf Pack", "Winterwolf Pack", "Snowwolf Pack", "Frostwolf Pack", "Icecrest Pack",
  "Wintercrest Pack", "Froststorm Pack", "Icefang Pack", "Snowstorm Pack", "Frostreign Pack",
  "Icepeak Pack", "Snowpeak Pack", "Frostpeak Pack", "Glacierpeak Pack", "Frosthunt Pack",
  "Snowhunt Pack", "Winterhunt Pack", "Glacierhunt Pack", "Frostwarden Pack",
  "Emberfang Pack", "Fireclaw Pack", "Blazefang Pack", "Inferno Pack", "Emberhowl Pack",
  "Firemoon Pack", "Bloodfire Pack", "Ashfang Pack", "Blazewolf Pack", "Emberwolf Pack",
  "Ashclaw Pack", "Inferno Fang Pack", "Blood Ember Pack", "Ashhowl Pack", "Firestorm Pack",
  "Blazehowl Pack", "Emberstorm Pack", "Firehunt Pack", "Ashstorm Pack", "Bloodflame Pack",
  "Elderfang Pack", "Ancient Moon Pack", "Primefang Pack", "First Howl Pack", "Elder Moon Pack",
  "Ancient Claw Pack", "Prime Moon Pack", "Wolf Ancestor Pack", "Elderclaw Pack", "Ancient Fang Pack",
  "Mythfang Pack", "Elder Hunt Pack", "Prime Hunt Pack", "Wolfkeeper Pack", "Moonkeeper Pack",
  "Ancient Wolf Pack", "Elder Wolf Pack", "Prime Wolf Pack", "Mythclaw Pack", "Mythwolf Pack",
  "Specter Fang Pack", "Ghostwolf Pack", "Phantom Moon Pack", "Spirit Fang Pack", "Wraithclaw Pack",
  "Phantomclaw Pack", "Ghostfang Pack", "Specterclaw Pack", "Phantomhowl Pack", "Spiritwolf Pack",
  "Wraithfang Pack", "Ghosthowl Pack", "Phantomstorm Pack", "Spiritstorm Pack", "Specterwolf Pack",
  "Phantomhunt Pack", "Spiritmoon Pack", "Wraithmoon Pack", "Ghostmoon Pack", "Spectermoon Pack",
  "Northfang Pack", "Southfang Pack", "Eastfang Pack", "Westfang Pack", "Highridge Pack",
  "Ironridge Pack", "Stone Ridge Pack", "Wolf Ridge Pack", "Black Ridge Pack", "Storm Ridge Pack",
  "Iron Valley Pack", "Wolf Valley Pack", "Dark Valley Pack", "Moon Valley Pack", "Blood Valley Pack",
  "Storm Valley Pack", "Frost Valley Pack", "Iron Hills Pack", "Wolf Hills Pack", "Storm Hills Pack",
  "Moon Hills Pack", "Dark Hills Pack", "Blood Hills Pack", "Silver Hills Pack", "Iron Plains Pack",
  "Wolf Plains Pack", "Storm Plains Pack", "Moon Plains Pack", "Dark Plains Pack", "Blood Plains Pack",
  "Alpha Fang Pack", "Alpha Moon Pack", "Alpha Wolf Pack", "Alpha Howl Pack", "Alpha Claw Pack",
  "Alpha Storm Pack", "Alpha Hunt Pack", "Alpha Blood Pack", "Alpha Night Pack", "Alpha Crown Pack",
  "Alpha Iron Pack", "Alpha Shadow Pack", "Alpha Ridge Pack", "Alpha Valley Pack", "Alpha Peak Pack",
  "Alpha Throne Pack", "Alpha Empire Pack", "Alpha Dominion Pack", "Alpha Reign Pack", "Alpha Dynasty Pack",
  "Broken Moon Pack", "Cursed Fang Pack", "Forsaken Howl Pack", "Exiled Wolf Pack", "Eternal Moon Pack",
  "Crimson Throne Pack", "Savage Crown Pack", "Iron Dominion Pack", "Shadow Throne Pack", "Eternal Fang Pack",
];

// Business / corporation names (300) — for finance/boardroom storylines.
const CORPORATION_NAMES = [
  "Blackridge Capital", "Ironcrest Holdings", "Sterling Peak Capital", "Apex Meridian Group", "Dominion Capital Partners",
  "Silvergate Investments", "Northbridge Financial", "Summit Crest Capital", "Grandstone Equity", "Falcon Ridge Holdings",
  "Pinnacle Trust Group", "Blue Harbor Capital", "Crescent Capital Group", "Orion Wealth Partners", "Atlas Peak Capital",
  "Monarch Equity Group", "Granite Bridge Capital", "Legacy Crest Holdings", "Crownstone Capital", "Titan Wealth Group",
  "Keystone Financial", "Vanguard Crest Capital", "Ironclad Investments", "Meridian Trust Holdings", "Summit Harbor Capital",
  "Apex Crown Financial", "Redwood Capital Group", "Dominion Bridge Capital", "Sovereign Crest Holdings", "Beacon Ridge Financial",
  "TitanCore Industries", "Dominion Global Group", "Crownstone International", "Orion Dominion Holdings", "Atlas Global Enterprises",
  "Apex Dominion Corporation", "Sovereign Industries Group", "IronPeak Global", "Falcon Dominion Holdings", "Legacy Global Corporation",
  "Crestline International", "Titan Dominion Enterprises", "Grandstone Worldwide", "Summit Dominion Group", "BluePeak International",
  "Ironbridge Worldwide", "Meridian Global Holdings", "Dominion Crest Enterprises", "Atlas Sovereign Group", "Apex Titan Corporation",
  "Crown Dominion International", "Granite Dominion Holdings", "Summit Worldwide Group", "Legacy Dominion Enterprises", "Orion Global Corporation",
  "Falcon Worldwide Industries", "Titan Legacy Holdings", "Sovereign Crest International", "Atlas Worldwide Enterprises", "Grand Dominion Corporation",
  "NovaCore Technologies", "QuantumBridge Systems", "Hyperion Tech Group", "Orion Data Systems", "Apex Circuit Technologies",
  "TitanByte Technologies", "NexaCore Innovations", "Vertex Digital Systems", "NovaGrid Technologies", "Apex AI Systems",
  "Hyperion Labs", "Orion Nexus Technologies", "QuantumSphere Technologies", "NovaTech Industries", "Titan Neural Systems",
  "NexaMind Technologies", "Vertex Quantum Labs", "Atlas Circuit Systems", "NovaLogic Innovations", "Hyperion Data Corp",
  "TitanCore AI", "Apex Quantum Systems", "Orion Cyber Technologies", "QuantumAxis Labs", "NexaWave Technologies",
  "NovaPulse Systems", "Hyperion Grid Technologies", "TitanCode Innovations", "Vertex AI Labs", "Orion Neural Systems",
  "Aurelius Luxury Group", "Crown & Vale Holdings", "Velmont Fashion House", "SilverCrest Luxury Brands", "Belmont Couture Group",
  "Sterling Luxe Corporation", "Monarch Fashion Group", "Crownstone Lifestyle Group", "Opulence Global Brands", "Aurelia Fashion Holdings",
  "Imperial Luxe Brands", "Prestige Crown Group", "Golden Crest Luxury", "Dominion Luxe Holdings", "Sovereign Style Group",
  "Velvet Crown Fashion", "Grand Monarch Brands", "Royal Vale Fashion Group", "Luxe Dominion Corporation", "Regal Crest Lifestyle",
  "TitanEnergy Corporation", "Atlas Petroleum Group", "IronPeak Energy", "Dominion Oil & Gas", "Falcon Ridge Energy",
  "Summit Petroleum Holdings", "GraniteCore Energy", "Crownstone Energy Group", "Orion Petro Industries", "Titan Petro Holdings",
  "Apex Energy Corporation", "Ironclad Oil Corporation", "Dominion Petro Systems", "Falcon Dominion Energy", "Atlas Power Industries",
  "Summit Energy International", "TitanFuel Corporation", "Crestline Energy Group", "IronPeak Petro Holdings", "Granite Dominion Energy",
  "Crownstone Bank Group", "Ironbridge Banking Corporation", "Sterling Crest Bank", "Monarch Financial Bank", "Dominion Trust Bank",
  "Atlas Banking Group", "Summit Crown Bank", "Falcon Ridge Bank", "Legacy Trust Banking", "Pinnacle Dominion Bank",
  "Granite Trust Bank", "Sovereign Bank Group", "Crestline Financial Bank", "Orion Trust Banking", "Titan Global Bank",
  "Apex Crown Bank", "Meridian Dominion Bank", "Silvergate Bank Group", "Beacon Trust Banking", "Northbridge Dominion Bank",
  "Apex Venture Partners", "Titan Venture Capital", "Summit Venture Group", "Falcon Venture Holdings", "Orion Venture Capital",
  "Granite Venture Partners", "Crestline Ventures", "Dominion Venture Capital", "Atlas Venture Holdings", "Pinnacle Venture Partners",
  "IronPeak Venture Group", "Silver Ridge Ventures", "Legacy Venture Capital", "Crownstone Ventures", "Sovereign Venture Group",
  "Beacon Venture Capital", "Nova Venture Partners", "Titan Crest Ventures", "Meridian Venture Group", "Summit Crest Ventures",
  "Atlas Maritime Group", "Dominion Global Shipping", "Falcon Maritime Holdings", "Titan Ocean Logistics", "Crestline Maritime Corporation",
  "Ironbridge Global Shipping", "Summit Ocean Freight", "Orion Maritime Logistics", "Crownstone Global Shipping", "Apex Ocean Freight",
  "Meridian Maritime Group", "Granite Ocean Shipping", "Beacon Maritime Holdings", "Northbridge Shipping Corporation", "Titan Maritime Logistics",
  "Falcon Ocean Transport", "Legacy Maritime Group", "Sovereign Ocean Shipping", "Atlas Freight Logistics", "IronPeak Maritime Holdings",
  "NovaCure Pharmaceuticals", "ApexBio Corporation", "TitanGen Pharma", "Orion Life Sciences", "Hyperion BioLabs",
  "Vertex BioSystems", "NexaGen Therapeutics", "Atlas BioPharma", "QuantumCure Laboratories", "NovaLife Pharma",
  "Hyperion Therapeutics", "TitanMed Pharmaceuticals", "Vertex Cure Labs", "Orion BioSystems", "NexaMed Pharma",
  "Atlas Therapeutics", "QuantumGen Pharma", "NovaBio Industries", "TitanGen Therapeutics", "Apex Life Sciences",
  "Crownstone Real Estate", "Atlas Property Group", "Dominion Realty Holdings", "Falcon Ridge Properties", "Granite Crest Realty",
  "Apex Property Holdings", "Meridian Real Estate Group", "Summit Crest Realty", "Titan Property Corporation", "Ironbridge Real Estate",
  "Legacy Property Holdings", "Sovereign Realty Group", "Pinnacle Property Holdings", "Beacon Crest Realty", "Falcon Dominion Realty",
  "Atlas Crown Real Estate", "Titan Crest Property Group", "Granite Dominion Realty", "Meridian Property Holdings", "Summit Dominion Realty",
  "NovaStar Entertainment", "Crownstone Studios", "Apex Media Group", "Titan Entertainment Holdings", "Orion Studios International",
  "Falcon Media Corporation", "Summit Star Studios", "Legacy Entertainment Group", "Atlas Film Corporation", "Hyperion Entertainment",
  "Pinnacle Media Holdings", "Silvergate Studios", "Beacon Film Corporation", "Grandstone Entertainment", "TitanStar Media",
  "Orion Crown Studios", "Dominion Entertainment Group", "Apex Star Productions", "Nova Dominion Studios", "Summit Crown Entertainment",
  "Sterling Dominion Group", "Crown Dynasty Holdings", "Titan Crown Corporation", "Atlas Dynasty Enterprises", "Monarch Dominion Group",
  "Sovereign Dynasty Holdings", "Apex Dynasty Corporation", "Iron Dynasty Enterprises", "Falcon Dynasty Holdings", "Dominion Crown Corporation",
  "Atlas Crown Dynasty", "Monarch Titan Holdings", "Sovereign Titan Group", "Iron Crown Dynasty", "Falcon Crown Enterprises",
  "Dominion Atlas Group", "Crown Titan Enterprises", "Apex Monarch Holdings", "Sovereign Atlas Corporation", "Titan Dynasty Holdings",
  "Blackridge Global Holdings", "Apex Crown Holdings", "IronPeak Global Capital", "Titan Global Industries", "Orion Global Dominion",
  "Falcon Global Enterprises", "Atlas Global Dominion", "Sovereign Global Holdings", "Meridian Global Capital", "Summit Global Industries",
  "Granite Global Corporation", "Crownstone Global Holdings", "Legacy Global Capital", "Dominion Global Enterprises", "Titan Global Dominion",
  "Falcon Global Capital", "Atlas Global Enterprises", "Sovereign Global Industries", "Apex Global Holdings", "Orion Global Capital",
  "Crown Dominion Holdings", "Black Titan Corporation", "Iron Throne Industries", "Monarch Dominion Enterprises", "Titan Throne Corporation",
  "Atlas Crown Holdings", "Sovereign Throne Industries", "Dominion Crown Corporation", "Apex Throne Enterprises", "Titan Crown Global",
];

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

/**
 * Get a random first name by gender.
 * @param {"male"|"female"} gender
 */
export function getRandomFirstName(gender) {
  const pool = gender === "female" ? FIRST_FEMALE : FIRST_MALE;
  return pickRandom(pool);
}

/**
 * Get a random last name.
 */
export function getRandomLastName() {
  return pickRandom(LAST_NAMES);
}

/**
 * Build a full name by mixing first + last.
 * @param {"male"|"female"} gender
 */
export function getRandomFullName(gender) {
  return `${getRandomFirstName(gender)} ${getRandomLastName()}`;
}

/**
 * Get a random billionaire/werewolf family name (e.g. "The Whitmores", "House Ashcroft").
 */
export function getRandomFamilyName() {
  return pickRandom(FAMILY_NAMES);
}

/**
 * Get a random werewolf pack name (e.g. "Shadowfang Pack", "Alpha Moon Pack").
 * Used when genre is WEREWOLF.
 */
export function getRandomPackName() {
  return pickRandom(WEREWOLF_PACK_NAMES);
}

/**
 * Get a random business/corporation name (e.g. "Blackridge Capital", "TitanCore Industries").
 * Used for finance/boardroom storylines.
 */
export function getRandomCorporationName() {
  return pickRandom(CORPORATION_NAMES);
}

/**
 * Get a consistent set of three names for a series: heroine, cold CEO, warm friend.
 * Uses mix-and-match so names feel fresh but stay consistent for the run.
 * @param {string} [genre] - "WEREWOLF" or "werewolf" → use a random pack name as familyName; otherwise use a dynasty family name.
 */
export function getSeriesNames(genre) {
  const usedLastNames = new Set();
  const usedFirstNames = new Set();

  function nextUniqueLastName() {
    let name = pickRandom(LAST_NAMES);
    for (let i = 0; i < 20 && usedLastNames.has(name); i++) name = pickRandom(LAST_NAMES);
    usedLastNames.add(name);
    return name;
  }
  function nextUniqueFirstName(gender) {
    const pool = gender === "female" ? FIRST_FEMALE : FIRST_MALE;
    let name = pickRandom(pool);
    for (let i = 0; i < 20 && usedFirstNames.has(name); i++) name = pickRandom(pool);
    usedFirstNames.add(name);
    return name;
  }

  const heroineFirst = nextUniqueFirstName("female");
  const coldFirst = nextUniqueFirstName("male");
  const warmFirst = nextUniqueFirstName("male");
  const last1 = nextUniqueLastName();
  const last2 = nextUniqueLastName();
  const last3 = nextUniqueLastName();

  const isWerewolf = String(genre || "").toUpperCase() === "WEREWOLF";
  const familyName = isWerewolf ? getRandomPackName() : getRandomFamilyName();
  const corporationName = getRandomCorporationName();

  return {
    heroine: `${heroineFirst} ${last1}`,
    coldCeo: `${coldFirst} ${last2}`,
    warmFriend: `${warmFirst} ${last3}`,
    familyName,
    corporationName,
    ...(isWerewolf && { packName: familyName }),
  };
}

export default {
  getRandomFirstName,
  getRandomLastName,
  getRandomFullName,
  getRandomFamilyName,
  getRandomPackName,
  getRandomCorporationName,
  getSeriesNames,
  FIRST_MALE,
  FIRST_FEMALE,
  LAST_NAMES,
  FAMILY_NAMES,
  WEREWOLF_PACK_NAMES,
  CORPORATION_NAMES,
};
