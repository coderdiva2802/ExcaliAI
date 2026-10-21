// ─────────────────────────────────────────────────────────
// Diagram fixtures: realistic planner + designer outputs for
// every quantitative kind.  Used by
//   • the deterministic self-test (layout regression), and
//   • the dev-only "fixtures" AI provider (AI_PROVIDER_ORDER=fixtures),
//     which lets the full app be tested in a browser without
//     spending any AI quota: type "fixture: <key>".
// Some fixtures deliberately contain model mistakes (a wrong
// jump label, a wrong angle) that the validator must correct.
// ─────────────────────────────────────────────────────────

export interface Fixture {
  question: string;
  plan: Record<string, unknown>;
  spec: Record<string, unknown>;
}

const steps = (...items: Array<[string, string]>) => items.map(([title, narration]) => ({ title, narration }));

export const FIXTURES: Record<string, Fixture> = {
  number_line: {
    question: "Show addition and subtraction on a number line",
    plan: {
      intent: "new_topic", topic: "integer addition on a number line", visualKind: "number_line",
      steps: steps(["Start at a point", "Every sum starts at the first number: here, 3."], ["Add a positive", "Adding 2 moves right two units, landing on 5."], ["Add a negative", "Adding −4 moves left four units, landing on −1."]),
      summary: "Addition as movement on a number line.",
    },
    spec: {
      title: "Adding integers on a number line", kind: "number_line",
      numberLine: {
        min: -5, max: 8, step: 1,
        points: [{ value: 3, label: "start", step: 1 }],
        // The second label is deliberately wrong; the validator must correct it to −4.
        jumps: [{ from: 3, to: 5, label: "+2", step: 2 }, { from: 3, to: -1, label: "+4", step: 3 }],
      },
      takeaways: ["Adding a positive moves right", "Adding a negative moves left"],
    },
  },
  inequality: {
    question: "Show -2 < x ≤ 4 on a number line",
    plan: { intent: "new_topic", topic: "inequalities", visualKind: "number_line", steps: steps(["Read the inequality", "x is greater than −2 and at most 4."], ["Open vs closed", "An open circle excludes −2; a filled circle includes 4."]), summary: "Inequalities on a number line." },
    spec: {
      title: "−2 < x ≤ 4", kind: "number_line",
      numberLine: { min: -5, max: 6, intervals: [{ from: -2, to: 4, includeFrom: false, includeTo: true, label: "−2 < x ≤ 4", step: 2 }, { from: 5, label: "x ≥ 5", includeFrom: true, role: "secondary", step: 2 }] },
    },
  },
  supply_demand: {
    question: "Plot supply and demand and find the equilibrium",
    plan: { intent: "new_topic", topic: "market equilibrium", visualKind: "coordinate_plane", steps: steps(["Demand slopes down", "As price rises, quantity demanded falls."], ["Supply slopes up", "Higher prices make producers supply more."], ["Equilibrium", "The curves cross where quantity supplied equals quantity demanded."]), summary: "Supply, demand and equilibrium." },
    spec: {
      title: "Supply and demand", kind: "coordinate_plane",
      plot: {
        xMin: 0, xMax: 10, yMin: 0, yMax: 12, xLabel: "Quantity", yLabel: "Price",
        functions: [{ expr: "10 - x", label: "Demand", step: 1 }, { expr: "2 + x", label: "Supply", step: 2 }],
        showIntersections: true,
      },
      takeaways: ["Equilibrium is where supply meets demand"],
    },
  },
  parabola: {
    question: "Graph y = x^2 - 2x - 3 and show its roots",
    plan: { intent: "new_topic", topic: "quadratic functions", visualKind: "coordinate_plane", steps: steps(["The parabola", "y = x² − 2x − 3 opens upward."], ["Roots", "It crosses the x-axis where y = 0."]), summary: "Graph of a quadratic." },
    spec: {
      title: "y = x² − 2x − 3", kind: "coordinate_plane",
      plot: { xMin: -4, xMax: 6, functions: [{ expr: "x^2 - 2x - 3", step: 1 }, { expr: "0", label: "y = 0", role: "muted", step: 2 }], showIntersections: true, points: [{ x: 1, y: -4, label: "vertex (1, −4)", step: 2 }] },
    },
  },
  trig: {
    question: "Plot sin(x) and cos(x)",
    plan: { intent: "new_topic", topic: "trigonometric functions", visualKind: "coordinate_plane", steps: steps(["Sine", "sin(x) starts at 0."], ["Cosine", "cos(x) is sine shifted left by π/2."]), summary: "Sine and cosine." },
    spec: { title: "sin(x) and cos(x)", kind: "coordinate_plane", plot: { xMin: -6.3, xMax: 6.3, yMin: -1.5, yMax: 1.5, functions: [{ expr: "sin(x)", label: "sin x", step: 1 }, { expr: "cos(x)", label: "cos x", step: 2 }] } },
  },
  triangle: {
    question: "Show a right triangle with sides 3, 4 and 5",
    plan: { intent: "new_topic", topic: "Pythagorean theorem", visualKind: "geometry", steps: steps(["The triangle", "A right triangle with legs 3 and 4."], ["Hypotenuse", "By Pythagoras, the hypotenuse is 5."]), summary: "The 3-4-5 triangle." },
    spec: {
      title: "The 3-4-5 right triangle", kind: "geometry",
      geometry: {
        points: [{ id: "a", x: 0, y: 0 }, { id: "b", x: 4, y: 0 }, { id: "c", x: 0, y: 3 }],
        polygons: [{ vertices: ["a", "b", "c"], step: 1 }],
        segments: [{ from: "a", to: "b", showLength: true, step: 1 }, { from: "a", to: "c", showLength: true, step: 1 }, { from: "b", to: "c", showLength: true, role: "danger", step: 2 }],
        // The second angle label is deliberately wrong (the real angle is ≈36.9°).
        angles: [{ vertex: "a", from: "b", to: "c", step: 1 }, { vertex: "b", from: "a", to: "c", label: "45°", step: 2 }],
      },
      formulas: [{ latex: "a^2 + b^2 = c^2", caption: "3² + 4² = 5²", step: 2 }],
    },
  },
  circle: {
    question: "Show a circle with a radius and a chord",
    plan: { intent: "new_topic", topic: "parts of a circle", visualKind: "geometry", steps: steps(["Radius", "From the centre to the circle."], ["Chord", "A segment joining two points on the circle."]), summary: "Parts of a circle." },
    spec: {
      title: "Radius and chord", kind: "geometry",
      geometry: {
        points: [{ id: "o", x: 0, y: 0, label: "O" }, { id: "p", x: 3, y: 0, label: "P" }, { id: "q", x: -1.8, y: 2.4, label: "Q" }, { id: "r", x: -1.8, y: -2.4, label: "R" }],
        circles: [{ center: "o", radius: 3, step: 1 }],
        segments: [{ from: "o", to: "p", label: "radius r", step: 1 }, { from: "q", to: "r", label: "chord", role: "accent", step: 2 }],
      },
    },
  },
  bar_chart: {
    question: "Bar chart of planets' moons",
    plan: { intent: "new_topic", topic: "moons of the outer planets", visualKind: "chart", steps: steps(["The data", "Number of moons for each outer planet (approximate counts)."]), summary: "Moons per planet.", caveats: ["Moon counts change as new moons are discovered."] },
    spec: { title: "Known moons of the outer planets", kind: "chart", chart: { type: "bar", categories: ["Jupiter", "Saturn", "Uranus", "Neptune"], series: [{ name: "Moons", values: [95, 146, 28, 16] }], yLabel: "Moons" } },
  },
  line_chart: {
    question: "Line chart comparing two series",
    plan: { intent: "new_topic", topic: "comparing trends", visualKind: "chart", steps: steps(["Two series", "Revenue and cost over four quarters."]), summary: "A line chart." },
    spec: { title: "Revenue vs cost", kind: "chart", chart: { type: "line", categories: ["Q1", "Q2", "Q3", "Q4"], series: [{ name: "Revenue", values: [12, 15, 14, 19] }, { name: "Cost", values: [10, 11, 13, 12] }], unit: "k$" } },
  },
  pie_chart: {
    question: "Pie chart of air composition",
    plan: { intent: "new_topic", topic: "composition of air", visualKind: "chart", steps: steps(["Composition", "Dry air is mostly nitrogen and oxygen."]), summary: "Air composition." },
    spec: { title: "Composition of dry air", kind: "chart", chart: { type: "pie", categories: ["Nitrogen", "Oxygen", "Argon", "Other"], series: [{ name: "share", values: [78.08, 20.95, 0.93, 0.04] }] } },
  },
  punnett: {
    question: "Punnett square for Aa x Aa",
    plan: { intent: "new_topic", topic: "Mendelian inheritance", visualKind: "table", steps: steps(["Parents", "Both parents are Aa."], ["Offspring", "1 AA : 2 Aa : 1 aa."]), summary: "A monohybrid cross." },
    spec: {
      title: "Punnett square: Aa × Aa", kind: "table",
      table: { columns: ["", "A", "a"], rows: [["A", "AA", "Aa"], ["a", "Aa", "aa"]], rowHeaders: true, highlight: [{ row: 0, col: 1, role: "success" }, { row: 1, col: 2, role: "warning" }] },
    },
  },
  truth_table: {
    question: "Truth table for AND and OR",
    plan: { intent: "new_topic", topic: "logic gates", visualKind: "table", steps: steps(["AND", "True only when both inputs are true."], ["OR", "True when at least one input is true."]), summary: "Truth tables." },
    spec: { title: "AND / OR truth table", kind: "table", table: { columns: ["A", "B", "A AND B", "A OR B"], rows: [["0", "0", "0", "0"], ["0", "1", "0", "1"], ["1", "0", "0", "1"], ["1", "1", "1", "1"]] } },
  },
  venn2: {
    question: "Venn diagram of mammals and animals that fly",
    plan: { intent: "new_topic", topic: "sets and classification", visualKind: "venn", steps: steps(["Two sets", "Mammals, and animals that can fly."], ["Overlap", "Bats are in both sets."]), summary: "A two-set Venn diagram." },
    spec: {
      title: "Mammals vs animals that fly", kind: "venn",
      venn: { sets: [{ id: "m", label: "Mammals" }, { id: "f", label: "Can fly" }], regions: [{ sets: ["m"], items: ["Dog", "Whale"] }, { sets: ["f"], items: ["Eagle", "Bee"] }, { sets: ["m", "f"], items: ["Bat"] }], universe: "Animals" },
    },
  },
  venn3: {
    question: "Venn diagram of three sets",
    plan: { intent: "new_topic", topic: "set intersections", visualKind: "venn", steps: steps(["Three sets", "Multiples of 2, 3 and 5 up to 30."]), summary: "Three-set Venn diagram." },
    spec: {
      title: "Multiples of 2, 3 and 5 (≤ 30)", kind: "venn",
      venn: {
        sets: [{ id: "two", label: "Multiples of 2" }, { id: "three", label: "Multiples of 3" }, { id: "five", label: "Multiples of 5" }],
        regions: [
          { sets: ["two"], items: ["2, 4, 8 …"] }, { sets: ["three"], items: ["3, 9, 21, 27"] }, { sets: ["five"], items: ["5, 25"] },
          { sets: ["two", "three"], items: ["6, 12, 18, 24"] }, { sets: ["two", "five"], items: ["10, 20"] }, { sets: ["three", "five"], items: ["15"] },
          { sets: ["two", "three", "five"], items: ["30"] },
        ],
      },
    },
  },
  water_cycle: {
    question: "Explain the water cycle",
    plan: { intent: "new_topic", topic: "the water cycle", visualKind: "cycle", steps: steps(["Evaporation", "The sun heats water, turning it into vapour."], ["Condensation", "Vapour cools into clouds."], ["Precipitation and collection", "Water falls and collects, and the cycle repeats."]), summary: "The water cycle." },
    spec: {
      title: "The water cycle", kind: "cycle",
      nodes: [
        { id: "evap", label: "Evaporation", detail: "sun heats water", step: 1 },
        { id: "cond", label: "Condensation", detail: "vapour forms clouds", step: 2 },
        { id: "prec", label: "Precipitation", detail: "rain, snow", step: 3 },
        { id: "coll", label: "Collection", detail: "oceans, rivers", step: 3 },
      ],
    },
  },
  ww1_timeline: {
    question: "Timeline of World War I",
    plan: { intent: "new_topic", topic: "World War I", visualKind: "scaled_timeline", steps: steps(["Outbreak", "The war began in July 1914."], ["Turning points", "The US entered in 1917."], ["End", "The armistice was signed in November 1918."]), summary: "Key dates of WWI." },
    spec: {
      title: "World War I: key dates", kind: "scaled_timeline",
      chronology: {
        events: [
          { date: "1914-06-28", label: "Assassination of Franz Ferdinand", step: 1 },
          { date: "1914-07-28", label: "War begins", role: "danger", step: 1 },
          { date: "1916-07-01", label: "Battle of the Somme", step: 2 },
          { date: "1917-04-06", label: "US enters the war", step: 2 },
          { date: "1918-11-11", label: "Armistice", role: "success", step: 3 },
        ],
        periods: [{ from: "1914-07-28", to: "1918-11-11", label: "World War I", step: 1 }],
      },
    },
  },
  history_eras: {
    question: "Timeline of ancient Rome",
    plan: { intent: "new_topic", topic: "ancient Rome", visualKind: "scaled_timeline", steps: steps(["Eras", "Kingdom, Republic, Empire."]), summary: "Roman eras." },
    spec: {
      title: "Ancient Rome", kind: "scaled_timeline",
      chronology: {
        events: [{ date: "753 BCE", label: "Founding (legendary)" }, { date: "509 BCE", label: "Republic founded" }, { date: "27 BCE", label: "Augustus becomes emperor" }, { date: 476, label: "Fall of the Western Empire", role: "danger" }],
        periods: [{ from: "753 BCE", to: "509 BCE", label: "Kingdom" }, { from: "509 BCE", to: "27 BCE", label: "Republic" }, { from: "27 BCE", to: 476, label: "Empire" }],
      },
    },
  },
  // ── Phase B ──
  incline: {
    question: "Draw the forces on a block on a 30 degree slope",
    plan: { intent: "new_topic", topic: "forces on an inclined plane", visualKind: "vectors", steps: steps(["Weight", "Gravity pulls the block straight down."], ["Normal and friction", "The slope pushes back perpendicular to its surface; friction acts up the slope."], ["Balance", "If the block is at rest, the forces balance."]), summary: "Forces on a slope." },
    spec: {
      title: "Block at rest on a 30° slope", kind: "vectors",
      vectors: {
        mode: "free_body", object: "Block", unit: "N", incline: 30,
        vectors: [
          { label: "Weight W", magnitude: 20, direction: "down", role: "danger", step: 1 },
          { label: "Normal force N", magnitude: 17.32, direction: "normal", role: "primary", step: 2 },
          { label: "Friction f = 10 N", magnitude: 10, direction: "up_slope", role: "success", step: 2 },
          // Deliberately wrong: the forces balance, so the net force is 0, not 5 N.
          { label: "Net force", magnitude: 5, direction: "down_slope", step: 3 },
        ],
      },
    },
  },
  vector_addition: {
    question: "Add a 3 N force east and a 4 N force north",
    plan: { intent: "new_topic", topic: "vector addition", visualKind: "vectors", steps: steps(["Head to tail", "Draw the second vector from the tip of the first."], ["Resultant", "The resultant joins the start to the final tip: 5 N."]), summary: "Vector addition." },
    spec: { title: "Adding two forces", kind: "vectors", vectors: { mode: "addition", unit: "N", vectors: [{ label: "F₁", magnitude: 3, angle: 0, step: 1 }, { label: "F₂", magnitude: 4, angle: 90, step: 1 }] } },
  },
  components: {
    question: "Resolve a 10 N force at 30 degrees into components",
    plan: { intent: "new_topic", topic: "resolving vectors", visualKind: "vectors", steps: steps(["The force", "A 10 N force at 30° above horizontal."], ["Components", "Fx = 10 cos 30° and Fy = 10 sin 30°."]), summary: "Components." },
    spec: { title: "Resolving a force", kind: "vectors", vectors: { mode: "components", unit: "N", vectors: [{ label: "F", magnitude: 10, angle: 30, step: 1 }] } },
  },
  series_circuit: {
    question: "Show a series circuit with a 12 V battery and two resistors",
    plan: { intent: "new_topic", topic: "series circuits", visualKind: "circuit", steps: steps(["The loop", "One path for the current."], ["Resistances add", "4 Ω + 2 Ω = 6 Ω, so I = 12 V ÷ 6 Ω = 2 A."]), summary: "Series circuit." },
    spec: {
      title: "A series circuit", kind: "circuit",
      circuit: {
        source: { type: "battery", voltage: 12 }, showCalculations: true,
        items: [{ type: "switch", step: 1 }, { type: "resistor", label: "R₁", value: 4, step: 2 }, { type: "ammeter", step: 2 }, { type: "resistor", label: "R₂", value: 2, step: 2 }],
      },
    },
  },
  parallel_circuit: {
    question: "Show two bulbs in parallel with a voltmeter",
    plan: { intent: "new_topic", topic: "parallel circuits", visualKind: "circuit", steps: steps(["Branches", "Each bulb has its own path, so the two bulbs share the same voltage."], ["Splitting the current", "The current splits between the branches: more flows through the bulb with less resistance."]), summary: "Parallel circuit." },
    spec: {
      title: "Bulbs in parallel", kind: "circuit",
      circuit: {
        source: { type: "battery", voltage: 6 }, showCalculations: true,
        items: [
          { type: "ammeter" },
          { parallel: [[{ type: "bulb", label: "L₁", value: 12 }], [{ type: "bulb", label: "L₂", value: 6 }]] },
          // Deliberately wrong: a voltmeter in series. The validator moves it in parallel.
          { type: "resistor", label: "R", value: 2 }, { type: "voltmeter" },
        ],
      },
    },
  },
  ethanol: {
    question: "Draw the structure of ethanol",
    // The stated formula is deliberately wrong (C2H5O); the validator shows the computed one.
    plan: { intent: "new_topic", topic: "ethanol", visualKind: "molecule", steps: steps(["The structure", "Two carbons, and an OH group."]), summary: "Ethanol." },
    spec: { title: "Ethanol", kind: "molecule", chemistry: { molecules: [{ name: "Ethanol", smiles: "CCO", formula: "C2H5O" }] } },
  },
  caffeine: {
    question: "Draw caffeine",
    plan: { intent: "new_topic", topic: "caffeine", visualKind: "molecule", steps: steps(["Structure", "Two fused rings with nitrogen atoms."]), summary: "Caffeine." },
    spec: { title: "Caffeine", kind: "molecule", chemistry: { molecules: [{ name: "caffeine", smiles: "CN1C=NC2=C1C(=O)N(C(=O)N2C)C" }] } },
  },
  combustion: {
    question: "Show the combustion of methane",
    plan: { intent: "new_topic", topic: "combustion of methane", visualKind: "molecule", steps: steps(["Reactants", "Methane reacts with oxygen."], ["Products", "Carbon dioxide and water form."]), summary: "Combustion." },
    spec: {
      title: "Combustion of methane", kind: "molecule",
      // Deliberately unbalanced (no coefficients); the validator balances it to CH4 + 2 O2 → CO2 + 2 H2O.
      chemistry: { conditions: "burns", molecules: [{ name: "methane", smiles: "C", role: "reactant", step: 1 }, { name: "oxygen", smiles: "O=O", role: "reactant", step: 1 }, { name: "carbon dioxide", smiles: "O=C=O", role: "product", step: 2 }, { name: "water", smiles: "O", role: "product", step: 2 }] },
    },
  },
  sodium_atom: {
    question: "Draw a sodium atom",
    plan: { intent: "new_topic", topic: "sodium atom", visualKind: "atom", steps: steps(["Nucleus", "11 protons and 12 neutrons."], ["Shells", "Electrons fill shells 2, 8, then 1."], ["Valence", "The single outer electron is easily lost."]), summary: "Sodium atom." },
    spec: { title: "A sodium atom", kind: "atom", atom: { element: "sodium" } },
  },
  chloride_ion: {
    question: "Draw a chloride ion",
    plan: { intent: "new_topic", topic: "chloride ion", visualKind: "atom", steps: steps(["Gaining an electron", "Chlorine gains one electron to fill its outer shell."]), summary: "Chloride ion." },
    spec: { title: "A chloride ion", kind: "atom", atom: { element: "Cl", charge: -1 } },
  },
  animal_cell: {
    question: "Label the parts of an animal cell",
    plan: { intent: "new_topic", topic: "animal cells", visualKind: "labelled_diagram", steps: steps(["Outer parts", "Membrane and cytoplasm."], ["Organelles", "Nucleus, mitochondria, ribosomes and more."]), summary: "Animal cell." },
    spec: { title: "Animal cell", kind: "labelled_diagram", labelled: { template: "animal_cell", labels: [] } },
  },
  plant_cell: {
    question: "Label a plant cell",
    plan: { intent: "new_topic", topic: "plant cells", visualKind: "labelled_diagram", steps: steps(["Plant-only parts", "Cell wall, vacuole and chloroplasts."]), summary: "Plant cell." },
    spec: { title: "Plant cell", kind: "labelled_diagram", labelled: { template: "plant_cell", labels: [{ part: "cell_wall" }, { part: "vacuole" }, { part: "chloroplast" }, { part: "nucleus" }, { part: "cytoplasm" }, { part: "golgi" }] } },
  },
  heart: {
    question: "Draw a labelled diagram of the heart",
    plan: { intent: "new_topic", topic: "the human heart", visualKind: "labelled_diagram", steps: steps(["Chambers", "Here is a simplified schematic of the heart: two atria above two ventricles."], ["Vessels", "Veins bring blood in, arteries carry it away."]), summary: "Heart." },
    spec: { title: "The human heart", kind: "labelled_diagram", labelled: { template: "heart", labels: [{ part: "right_atrium", step: 1 }, { part: "left_atrium", step: 1 }, { part: "right_ventricle", step: 1 }, { part: "left_ventricle", step: 1 }, { part: "aorta", step: 2 }, { part: "pulmonary_artery", step: 2 }, { part: "superior_vena_cava", step: 2 }, { part: "pulmonary_veins", step: 2 }] } },
  },
  eye: {
    question: "Label the eye",
    plan: { intent: "new_topic", topic: "the eye", visualKind: "labelled_diagram", steps: steps(["Front", "Light enters through the cornea and pupil."], ["Back", "The lens focuses it onto the retina."]), summary: "Eye." },
    spec: { title: "The human eye", kind: "labelled_diagram", labelled: { template: "eye", labels: [] } },
  },
  flower: {
    question: "Parts of a flower",
    plan: { intent: "new_topic", topic: "flower structure", visualKind: "labelled_diagram", steps: steps(["Parts", "Male and female parts of a flower."]), summary: "Flower." },
    spec: { title: "Parts of a flower", kind: "labelled_diagram", labelled: { template: "flower", labels: [] } },
  },
  earth_layers: {
    question: "Layers of the Earth",
    plan: { intent: "new_topic", topic: "Earth's structure", visualKind: "labelled_diagram", steps: steps(["Layers", "Crust, mantle, outer and inner core."]), summary: "Earth layers." },
    spec: { title: "Inside the Earth", kind: "labelled_diagram", labelled: { template: "earth_layers", labels: [] } },
  },
  europe_map: {
    question: "Map of the Allied and Central Powers in WW1",
    plan: { intent: "new_topic", topic: "WWI alliances", visualKind: "map", steps: steps(["Central Powers", "Germany, Austria-Hungary and the Ottoman Empire."], ["Allies", "France, Britain and Russia."]), summary: "WWI alliances." },
    spec: {
      title: "WWI alliances (modern borders)", kind: "map",
      map: {
        region: "europe",
        countries: [
          { name: "Germany", role: "danger", step: 1 }, { name: "Austria", role: "danger", step: 1 }, { name: "Hungary", role: "danger", step: 1 }, { name: "Turkey", role: "danger", step: 1 },
          { name: "France", role: "primary", step: 2 }, { name: "UK", role: "primary", step: 2 }, { name: "Russia", role: "primary", step: 2 }, { name: "Atlantis", step: 2 },
        ],
        // Deliberately wrong coordinates for Paris; the gazetteer corrects them.
        markers: [{ label: "Paris", lat: 40, lon: 10, step: 2 }, { label: "Berlin", lat: 52.5, lon: 13.4, step: 1 }],
      },
    },
  },
  silk_road: {
    question: "Show the Silk Road route",
    plan: { intent: "new_topic", topic: "the Silk Road", visualKind: "map", steps: steps(["East", "Trade began in China."], ["West", "Goods reached the Mediterranean."]), summary: "Silk Road." },
    spec: {
      title: "The Silk Road (simplified)", kind: "map",
      map: {
        markers: [{ label: "Xi'an", lat: 34.34, lon: 108.94, country: "China", step: 1 }, { label: "Samarkand", lat: 39.65, lon: 66.96, country: "Uzbekistan", step: 1 }, { label: "Baghdad", step: 2 }, { label: "Constantinople", step: 2 }],
        routes: [{ from: "Xi'an", to: "Samarkand", step: 1 }, { from: "Samarkand", to: "Baghdad", step: 2 }, { from: "Baghdad", to: "Constantinople", step: 2 }],
      },
    },
  },
  // ── More labelled templates ──
  neuron: {
    question: "Label a neuron",
    plan: { intent: "new_topic", topic: "the neuron", visualKind: "labelled_diagram", steps: steps(["Structure", "Neurons carry electrical signals from the dendrites to the axon terminals."]), summary: "the neuron." },
    spec: { title: "Neuron", kind: "labelled_diagram", labelled: { template: "neuron", labels: [] } },
  },
  leaf_section: {
    question: "Label a leaf cross-section",
    plan: { intent: "new_topic", topic: "leaf structure", visualKind: "labelled_diagram", steps: steps(["Structure", "A leaf's layers are arranged for photosynthesis and gas exchange."]), summary: "leaf structure." },
    spec: { title: "Leaf cross-section", kind: "labelled_diagram", labelled: { template: "leaf_section", labels: [] } },
  },
  digestive_system: {
    question: "Label the digestive system",
    plan: { intent: "new_topic", topic: "the digestive system", visualKind: "labelled_diagram", steps: steps(["Structure", "Food passes from the mouth through the gut; the liver and pancreas help digest it."]), summary: "the digestive system." },
    spec: { title: "Digestive system", kind: "labelled_diagram", labelled: { template: "digestive_system", labels: [] } },
  },
  tooth: {
    question: "Label the parts of a tooth",
    plan: { intent: "new_topic", topic: "tooth structure", visualKind: "labelled_diagram", steps: steps(["Structure", "A tooth has hard enamel on the crown and living pulp inside."]), summary: "tooth structure." },
    spec: { title: "A tooth", kind: "labelled_diagram", labelled: { template: "tooth", labels: [] } },
  },
  dna: {
    question: "Label the structure of DNA",
    plan: { intent: "new_topic", topic: "DNA structure", visualKind: "labelled_diagram", steps: steps(["Structure", "Two backbones twist into a double helix; bases pair A with T and G with C."]), summary: "DNA structure." },
    spec: { title: "Structure of DNA", kind: "labelled_diagram", labelled: { template: "dna", labels: [] } },
  },
  respiratory_system: {
    question: "Label the respiratory system",
    plan: { intent: "new_topic", topic: "the respiratory system", visualKind: "labelled_diagram", steps: steps(["Structure", "Air travels down the trachea and bronchi to millions of alveoli."]), summary: "the respiratory system." },
    spec: { title: "Respiratory system", kind: "labelled_diagram", labelled: { template: "respiratory_system", labels: [] } },
  },
  // ── Sketched (no built-in template): reference diagram or AI sketch ──
  ear: {
    question: "Label the parts of the human ear",
    plan: { intent: "new_topic", topic: "the human ear", visualKind: "labelled_diagram", steps: steps(["Outer ear", "The pinna funnels sound down the ear canal to the eardrum."], ["Middle ear", "Three tiny bones pass the vibrations to the inner ear."], ["Inner ear", "The cochlea turns vibrations into nerve signals."]), summary: "the human ear." },
    spec: { title: "The human ear", kind: "labelled_diagram", labelled: { template: "human_ear", labels: [
      { part: "auricle", text: "Pinna (auricle)", step: 1 }, { part: "ear_canal", text: "Ear canal", step: 1 }, { part: "eardrum", text: "Eardrum", step: 1 },
      { part: "malleus", text: "Malleus", step: 2 }, { part: "incus", text: "Incus", step: 2 }, { part: "stapes", text: "Stapes", step: 2 },
      { part: "semicircular_canals", text: "Semicircular canals", step: 3 }, { part: "cochlea", text: "Cochlea", step: 3 },
      { part: "cochlear_nerve", text: "Cochlear nerve", step: 3 }, { part: "eustachian_tube", text: "Eustachian tube", step: 2 },
    ] } },
  },
  // ── Worked example drawn beside the diagram ──
  dijkstra: {
    question: "Explain Dijkstra's algorithm with a worked example, all steps",
    plan: {
      intent: "new_topic", topic: "Dijkstra's algorithm", visualKind: "flowchart",
      steps: steps(
        ["What it does", "Dijkstra's algorithm finds the shortest distance from one start node to every other node when all edge weights are non-negative."],
        ["The loop", "Repeatedly take the unvisited node with the smallest distance, then relax its edges: keep a neighbour's new distance only if it is shorter."],
        ["Example setup", "Our graph has five nodes. We start at A with distance 0; every other node starts at infinity."],
        ["Visit A", "From A, B can be reached in 4 and C in 2."],
        ["Visit C", "C is the closest unvisited node. Going through C, B improves to 3, D becomes 10 and E becomes 12."],
        ["Visit B", "B is next at 3. Through B, D improves from 10 to 8."],
        ["Visit D and E", "Through D, E improves from 12 to 10. Visiting E changes nothing, so the final distances are B 3, C 2, D 8 and E 10."],
      ),
      summary: "Dijkstra's algorithm with a fully worked example.",
      workedExample: {
        title: "Worked example: shortest paths from A",
        problem: "Undirected graph with edges A–B 4, A–C 2, B–C 1, B–D 5, C–D 8, C–E 10, D–E 2. Find the shortest distance from A to every node.",
        figure: {
          nodes: ["A", "B", "C", "D", "E"].map((id) => ({ id, label: id })),
          edges: [["A", "B", "4"], ["A", "C", "2"], ["B", "C", "1"], ["B", "D", "5"], ["C", "D", "8"], ["C", "E", "10"], ["D", "E", "2"]].map(([from, to, label]) => ({ from, to, label })),
          directed: false,
        },
        steps: [
          { title: "Initialise", lines: ["dist(A) = 0; all others = ∞", "Unvisited: A, B, C, D, E"], table: { columns: ["", "A", "B", "C", "D", "E"], rows: [["dist", "0", "∞", "∞", "∞", "∞"]], rowHeaders: true }, step: 3 },
          { title: "Visit A (dist 0)", lines: ["dist(B) = min(∞, 0 + 4) = 4", "dist(C) = min(∞, 0 + 2) = 2"], table: { columns: ["", "A", "B", "C", "D", "E"], rows: [["dist", "0 ✓", "4", "2", "∞", "∞"]], rowHeaders: true }, step: 4 },
          { title: "Visit C (dist 2)", lines: ["dist(B) = min(4, 2 + 1) = 3", "dist(D) = min(∞, 2 + 8) = 10", "dist(E) = min(∞, 2 + 10) = 12"], table: { columns: ["", "A", "B", "C", "D", "E"], rows: [["dist", "0 ✓", "3", "2 ✓", "10", "12"]], rowHeaders: true }, step: 5 },
          { title: "Visit B (dist 3)", lines: ["dist(D) = min(10, 3 + 5) = 8", "C already visited: skip"], table: { columns: ["", "A", "B", "C", "D", "E"], rows: [["dist", "0 ✓", "3 ✓", "2 ✓", "8", "12"]], rowHeaders: true }, step: 6 },
          { title: "Visit D (dist 8)", lines: ["dist(E) = min(12, 8 + 2) = 10"], table: { columns: ["", "A", "B", "C", "D", "E"], rows: [["dist", "0 ✓", "3 ✓", "2 ✓", "8 ✓", "10"]], rowHeaders: true }, step: 7 },
          { title: "Visit E (dist 10)", lines: ["No unvisited neighbours: done"], table: { columns: ["", "A", "B", "C", "D", "E"], rows: [["dist", "0 ✓", "3 ✓", "2 ✓", "8 ✓", "10 ✓"]], rowHeaders: true }, step: 7 },
        ],
        answer: "From A: B = 3 (A→C→B), C = 2, D = 8 (A→C→B→D), E = 10 (A→C→B→D→E).",
      },
    },
    spec: {
      title: "Dijkstra's algorithm", kind: "flowchart",
      nodes: [
        { id: "init", label: "Initialise", detail: "dist[start] = 0, others = ∞", step: 2 },
        { id: "check", label: "Unvisited nodes left?", shape: "diamond", step: 2 },
        { id: "pick", label: "Pick closest unvisited node", step: 2 },
        { id: "relax", label: "Relax its edges", detail: "keep shorter distances", step: 2 },
        { id: "done", label: "Done: shortest distances", role: "success", step: 2 },
      ],
      edges: [
        { from: "init", to: "check" }, { from: "check", to: "pick", label: "yes" }, { from: "pick", to: "relax" },
        { from: "relax", to: "check" }, { from: "check", to: "done", label: "no" },
      ],
    },
  },
};

/** Resolve "fixture: number_line" (or a fixture's exact question) to a fixture key. */
export function findFixture(text: string): string | undefined {
  const m = /fixture:\s*([a-z0-9_]+)/i.exec(text);
  if (m && FIXTURES[m[1].toLowerCase()]) return m[1].toLowerCase();
  const lower = text.toLowerCase();
  return Object.keys(FIXTURES).find((k) => lower.includes(FIXTURES[k].question.toLowerCase()));
}
