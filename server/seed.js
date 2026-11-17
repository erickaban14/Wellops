// First-start demo data: master data for an oil-services contractor, one live project with a week of work tickets,
// and a second confirmed order waiting for planning.
import { hashPassword } from './auth.js';
import { PILLARS } from './models.js';
import { ROLES } from './roles.js';
import { db } from './store/index.js';
import { addDays, today } from './util.js';
import { approveMrp, firmMrp, generateMps, runMrp } from './services/planning.js';
import { saveTicket } from './services/operations.js';

const D = n => addDays(today(), n);

export async function seedIfEmpty() {
  if ((await db.list('users')).length) return false;
  console.log('[seed] Empty database - loading demo data...');
  const ins = (t, rows) => db.insert(t, rows);

  await ins('settings', [
    ['max_work_days', '15', 'Maximum consecutive working days before Rig Manager approval is required'],
    ['regular_hours_per_day', '8', 'Hours per day paid at regular rate; the rest is overtime'],
    ['ot_multiplier', '1.25', 'Overtime pay multiplier'],
    ['payroll_tax_pct', '10', 'Withholding tax % of gross'],
    ['payroll_contribution_pct', '4.5', 'Statutory contributions % of gross'],
    ['auto_consolidate_online', 'true', 'Consolidate timesheets in real time for tickets entered online'],
    ['vpn_connect_url', process.env.VPN_CONNECT_URL || '', 'URL / deep link opened on the device after face login to bring up the VPN client'],
    ['company_name', 'ProStars Energy Services', 'Shown in the header'],
    ['currency', 'USD', 'Currency code shown next to amounts'],
  ].map(([key, value, description]) => ({ key, value, description })));

  await ins('accounts', [['1000', 'Cash & Bank', 'asset'], ['1200', 'Accounts Receivable', 'asset'], ['1300', 'Inventory', 'asset'], ['1500', 'Machinery & Equipment', 'asset'],
    ['2000', 'Accounts Payable', 'liability'], ['2100', 'Payroll Payable', 'liability'], ['2200', 'Withholdings Payable', 'liability'], ['3000', 'Equity', 'equity'],
    ['4000', 'Service Revenue', 'income'], ['5000', 'Project Materials Expense', 'expense'], ['5900', 'Inventory Adjustments', 'expense'], ['6100', 'Salaries & Wages', 'expense']]
    .map(([code, name, type]) => ({ code, name, type })));

  // ---- People ----
  const first = ['Ramon', 'Liza', 'Carlos', 'Mei', 'Jorge', 'Anita', 'Samuel', 'Grace', 'Victor', 'Nora', 'Daniel', 'Irene', 'Marco', 'Tessa', 'Hassan', 'Paula', 'Elias', 'Rosa', 'Kenji', 'Dina'];
  const last = ['Navarro', 'Okafor', 'Delgado', 'Tan', 'Whitfield', 'Soriano', 'Haddad', 'Lindqvist', 'Mercado', 'Brandt', 'Aquino', 'Petrov', 'Salazar', 'Nguyen', 'Castillo', 'Reyes'];
  let n = 0;
  const person = () => `${first[n % first.length]} ${last[(n++ * 7 + 3) % last.length]}`;
  const emp = (position, department, discipline, rate) => ({ emp_no: `E${String(n + 1).padStart(3, '0')}`, name: person(), position, department, discipline, hourly_rate: rate, daily_allowance: department === 'Operations' ? 15 : 0, hire_date: D(-900 + n * 11), status: 'active' });
  const crewSpec = [['Rig Manager', 1, 38], ['Rig Supervisor', 2, 30], ['Toolpusher', 1, 32], ['Driller', 3, 26], ['Assistant Driller', 2, 21], ['Derrickman', 3, 19], ['Floorman', 6, 15], ['Roustabout', 3, 12],
    ['Mechanic', 2, 20], ['Electrician', 1, 20], ['HSE Officer', 2, 22], ['Pump Supervisor', 1, 27], ['Pump Operator', 4, 18], ['Frac Crew', 2, 17], ['Wireline Operator', 1, 23], ['Coiled Tubing Operator', 1, 23], ['Machine Engineer', 2, 28]];
  const disc = p => (/Pump/.test(p) ? 'Pump Operations' : /Frac/.test(p) ? 'Pumping & Fracturing Crew' : /Wireline|Coiled|Snubbing/.test(p) ? 'Well Services & Interventions' : /Mechanic|Electric|HSE|Engineer/.test(p) ? 'Support' : 'Drilling Operations');
  const field = await ins('employees', crewSpec.flatMap(([p, q, r]) => Array.from({ length: q }, () => emp(p, /Engineer/.test(p) ? 'Engineering' : 'Operations', disc(p), r))));
  const byPos = p => field.filter(e => e.position === p);
  const DEPT = { Operations: 'Operations', Engineering: 'Engineering', Logistics: 'Logistics', Planning: 'Operations', Procurement: 'Procurement', Warehouse: 'Warehouse', Sales: 'Sales', Finance: 'Finance', HR: 'HR', System: 'Finance' };
  const linked = { rig_manager: byPos('Rig Manager')[0], rig_supervisor: byPos('Rig Supervisor')[0], rig_field: byPos('Floorman')[0], machine_engineer: byPos('Machine Engineer')[0], engineering_manager: byPos('Machine Engineer')[1], employee: byPos('Driller')[0] };
  const users = [];
  for (const [key, r] of Object.entries(ROLES)) {
    const e = linked[key] || await ins('employees', emp('Office Staff', DEPT[r.group], 'Support', 24));
    users.push({ name: e.name, email: `${key.replace(/_/g, '.')}@wellops.test`, role: key, employee_id: e.id, active: true, password_hash: hashPassword(process.env.SEED_PASSWORD || 'ChangeMe-2026') });
  }
  await ins('users', users);
  const admin = { name: 'System', role: 'admin', employee_id: byPos('Rig Supervisor')[0].id };

  // ---- Training: 4-pillar matrix ----
  const [P1, P2, P3, P4] = PILLARS;
  const courses = await ins('training_courses', [
    ['HSE-01', 'HSE Induction & Field Orientation', P1, 'IOGP Life-Saving Rules', 'All', 1, 24],
    ['HSE-02', 'H2S Awareness & Breathing Apparatus', P1, 'ANSI/ASSP Z390.1', 'All', 1, 12],
    ['HSE-03', 'Permit to Work, JSA & Stop Work Authority', P1, 'IOGP Report 459', 'All', 1, 24],
    ['HSE-04', 'Dropped Objects Prevention & Manual Handling', P1, 'DROPS', 'All', 1, 24],
    ['WC-01', 'Well Control - Introductory (Level 2)', P2, 'IWCF Level 2 / IADC WellSharp Introductory', 'Drilling Operations', 3, 60],
    ['WC-02', 'Well Control - Driller (Level 3)', P2, 'IWCF Level 3 / IADC WellSharp Driller', 'Drilling Operations', 5, 24],
    ['WC-03', 'Well Control - Supervisor (Level 4)', P2, 'IWCF Level 4 / IADC WellSharp Supervisor', 'Drilling Operations', 5, 24],
    ['WC-04', 'Well Intervention Pressure Control', P2, 'IWCF WIPC / IOGP Report 476', 'Well Services & Interventions', 5, 24],
    ['WC-05', 'Enhanced Well Control Crew Resource Management', P2, 'IOGP Report 476', 'Drilling Operations', 2, 24],
    ['TO-01', 'Rig Floor Operations & Pipe Handling', P3, 'API RP 54', 'Drilling Operations', 3, 36],
    ['TO-02', 'Derrick Operations & Working at Height', P3, 'API RP 54', 'Drilling Operations', 2, 24],
    ['TO-03', 'Reciprocating Pump Operation & Maintenance', P3, 'API Std 674', 'Pump Operations', 3, 36],
    ['TO-04', 'High-Pressure Pumping & Treating Iron Safety', P3, 'API RP 7HU1', 'Pumping & Fracturing Crew', 2, 24],
    ['TO-05', 'Wireline Operations', P3, 'API RP 54', 'Well Services & Interventions', 4, 36],
    ['TO-06', 'Coiled Tubing Operations', P3, 'API RP 16ST', 'Well Services & Interventions', 4, 36],
    ['TO-07', 'Snubbing & Hydraulic Workover', P3, 'API RP 54', 'Well Services & Interventions', 4, 36],
    ['ER-01', 'Emergency Response & Muster Drills', P4, 'Company ERP', 'All', 1, 12],
    ['ER-02', 'Fire Fighting & Fire Team Member', P4, 'NFPA 600', 'All', 2, 24],
    ['ER-03', 'First Aid, CPR & AED', P4, 'Red Cross', 'All', 1, 24],
    ['ER-04', 'Rig Evacuation & Rescue at Height', P4, 'OPITO', 'Drilling Operations', 2, 24],
  ].map(([code, name, pillar, standard, discipline, duration_days, validity_months]) => ({ code, name, pillar, standard, discipline, duration_days, validity_months, provider: 'Accredited provider' })));
  const cid = code => courses.find(c => c.code === code).id;
  const MX = { 'All Personnel': ['HSE-01', 'HSE-02', 'HSE-03', 'HSE-04', 'ER-01', 'ER-03'], 'Rig Manager': ['WC-03', 'WC-05', 'ER-02'], 'Rig Supervisor': ['WC-03', 'WC-05', 'ER-02'], Toolpusher: ['WC-03', 'WC-05', 'TO-01'],
    Driller: ['WC-02', 'WC-05', 'TO-01'], 'Assistant Driller': ['WC-02', 'TO-01'], Derrickman: ['WC-01', 'TO-02', 'ER-04'], Floorman: ['WC-01', 'TO-01'], Roustabout: ['TO-01'],
    'Pump Supervisor': ['TO-03', 'TO-04', 'ER-02'], 'Pump Operator': ['TO-03', 'TO-04'], 'Frac Crew': ['TO-04'], 'Wireline Operator': ['WC-04', 'TO-05'], 'Coiled Tubing Operator': ['WC-04', 'TO-06'],
    'Snubbing Operator': ['WC-04', 'TO-07'], 'HSE Officer': ['ER-02', 'ER-04'], Mechanic: ['TO-03'] };
  await ins('training_matrix', Object.entries(MX).flatMap(([position, list]) => list.map(c => ({ position, course_id: cid(c), mandatory: true }))));
  // Most people are compliant; a deterministic handful are missing or near expiry so the matrix has something to show.
  const records = [];
  (await db.list('employees')).forEach((e, i) => [...MX['All Personnel'], ...(MX[e.position] || [])].forEach((c, j) => {
    const k = (i * 5 + j * 3) % 17;
    if (k === 0) return;
    const course = courses.find(x => x.code === c);
    const done = D(k === 1 ? -course.validity_months * 30 + 20 : -60 - ((i + j) % 6) * 30);
    records.push({ employee_id: e.id, course_id: course.id, completed_date: done, expiry_date: addDays(done, course.validity_months * 30), certificate_no: `${c}-${1000 + i * 10 + j}` });
  }));
  await ins('training_records', records);
  await ins('leaves', [
    { employee_id: byPos('Floorman')[5].id, leave_type: 'vacation', start_date: D(18), end_date: D(30), paid: true, status: 'approved' },
    { employee_id: byPos('Driller')[2].id, leave_type: 'rotation off', start_date: D(15), end_date: D(35), paid: false, status: 'approved' },
    { employee_id: byPos('Pump Operator')[0].id, leave_type: 'sick', start_date: D(2), end_date: D(4), paid: true, status: 'requested' },
  ]);

  // ---- API standards, machines, maintenance, documents ----
  await ins('api_standards', [
    ['API Spec 4F', 'Drilling and Well Servicing Structures', 'all', 'Masts, derricks and substructures: design loads, materials and marking.'],
    ['API Spec 7K', 'Drilling and Well Servicing Equipment', 'all', 'Rotary tables, slips, mud pump components, drawworks, power tongs.'],
    ['API Spec 8C', 'Drilling and Production Hoisting Equipment', 'all', 'Crown blocks, travelling blocks, hooks, elevators, swivels.'],
    ['API Std 53', 'Well Control Equipment Systems for Drilling Wells', 'drilling', 'BOP stack arrangement, testing and maintenance.'],
    ['API Spec 16A', 'Drill-through Equipment', 'drilling', 'Ram and annular BOPs, drilling spools, connectors.'],
    ['API RP 54', 'Occupational Safety for Drilling and Well Servicing', 'all', 'Safe work practices on drilling and servicing rigs.'],
    ['API Std 674', 'Positive Displacement Pumps - Reciprocating', 'surface pumping', 'Design, testing and rating of reciprocating pumps.'],
    ['API Std 610', 'Centrifugal Pumps', 'surface pumping', 'Centrifugal pumps for petroleum and natural gas service.'],
    ['API Spec 11E', 'Pumping Units', 'surface pumping', 'Beam pumping unit structures and gear reducers.'],
    ['API RP 16ST', 'Coiled Tubing Well Control Equipment Systems', 'workover', 'Well control for coiled tubing interventions.'],
  ].map(([code, title, operation, scope]) => ({ code, title, operation, scope })));
  const machines = await ins('machines', [
    ['RIG-01', 'Land Drilling Rig 1500 HP', 'drilling rig', 'drilling', '4F, 7K, 8C, 16A', 18000, 1200, 7500, 1500, 'Top drive 350T; 2x triplex mud pumps 1600HP; 13-5/8" 10K BOP stack; iron roughneck; 5" drill pipe string', 22000, 9500000],
    ['RIG-02', 'Land Drilling Rig 1000 HP', 'drilling rig', 'drilling', '4F, 7K, 8C, 16A', 12000, 900, 5000, 1000, 'Kelly drive; 2x triplex mud pumps 1000HP; 13-5/8" 5K BOP stack; 4-1/2" drill pipe string', 16000, 6200000],
    ['RIG-03', 'Land Drilling Rig 750 HP', 'drilling rig', 'drilling', '4F, 7K, 8C', 8000, 700, 5000, 750, 'Kelly drive; 2x triplex mud pumps 800HP; 11" 5K BOP stack', 12000, 4100000],
    ['WOR-01', 'Workover Rig 550 HP', 'workover rig', 'workover', '4F, 8C, 7K', 12000, 400, 5000, 550, 'Power tongs; 7-1/16" 5K BOP; tubing elevators; workover pump', 8000, 2300000],
    ['WOR-02', 'Workover Rig 350 HP', 'workover rig', 'workover', '4F, 8C', 8000, 300, 3000, 350, 'Power tongs; 7-1/16" 3K BOP; rod handling tools', 6000, 1500000],
    ['PMP-01', 'Triplex Pump Unit 600 HP', 'pump unit', 'surface pumping', '674, 7K', 0, 500, 10000, 600, 'Suction manifold; 2" 1502 treating iron set; pressure relief valve; data van link', 3500, 650000],
    ['PMP-02', 'Quintuplex Frac Pump 2250 HP', 'pump unit', 'surface pumping', '674', 0, 900, 15000, 2250, '3" 1502 treating iron set; blender tie-in; remote kick-out system', 6000, 1400000],
    ['PMP-03', 'Centrifugal Transfer Pump', 'pump unit', 'surface pumping', '610', 0, 2000, 300, 250, '6" suction hoses; flow meter skid', 1500, 180000],
  ].map(([code, name, machine_type, operation, api_code, max_depth_ft, max_flow_gpm, max_pressure_psi, horsepower, accessories, day_rate, purchase_cost], i) =>
    ({ code, name, machine_type, operation, api_code, max_depth_ft, max_flow_gpm, max_pressure_psi, horsepower, accessories, day_rate, purchase_cost, status: 'available', location: 'Main yard', purchase_date: D(-1500 + i * 120) })));
  const mid = code => machines.find(m => m.code === code).id;
  await ins('maintenance_plans', [
    { machine_id: mid('RIG-02'), pm_type: 'certification', description: 'Category IV mast inspection & BOP recertification', start_date: D(20), end_date: D(32), status: 'scheduled' },
    { machine_id: mid('PMP-01'), pm_type: 'preventive', description: 'Fluid end overhaul, valves & seats', start_date: D(5), end_date: D(8), status: 'scheduled' },
    { machine_id: mid('WOR-01'), pm_type: 'preventive', description: '500-hour engine and drawworks service', start_date: D(40), end_date: D(42), status: 'scheduled' },
    { machine_id: mid('RIG-01'), pm_type: 'inspection', description: 'Top drive 6-month inspection', start_date: D(55), end_date: D(57), status: 'scheduled' },
  ]);
  await ins('documents', [
    { title: 'RIG-01 Operations & Maintenance Manual', doc_type: 'manual', api_code: '4F, 7K', machine_id: mid('RIG-01') },
    { title: 'RIG-02 Operations & Maintenance Manual', doc_type: 'manual', api_code: '4F, 7K', machine_id: mid('RIG-02') },
    { title: 'Triplex Pump Fluid End Service Procedure', doc_type: 'procedure', api_code: '674', machine_id: mid('PMP-01') },
    { title: 'BOP Test Procedure', doc_type: 'procedure', api_code: '16A' },
  ]);

  // ---- Suppliers, items ----
  const sup = await ins('suppliers', [['Gulf Drilling Fluids Co.', 'Net 30'], ['Titan Oilfield Supply', 'Net 45'], ['Precision Pump Parts Ltd.', 'Net 30'], ['SafeSite PPE & Instruments', 'Net 15']]
    .map(([name, payment_terms]) => ({ name, payment_terms, contact_person: 'Sales Desk', email: `sales@${name.split(' ')[0].toLowerCase()}.test` })));
  const items = await ins('items', [
    ['MUD-BEN', 'Bentonite', 'material', 'sack', 14, 900, 7, 300, 600, 100, 100, 0, 0],
    ['MUD-BAR', 'Barite', 'material', 'sack', 19, 400, 10, 250, 500, 80, 100, 0, 0],
    ['CMT-G', 'Cement Class G', 'material', 'sack', 22, 350, 14, 200, 400, 50, 100, 0, 1],
    ['BIT-PDC85', 'PDC Drill Bit 8-1/2"', 'tool', 'ea', 9500, 2, 30, 1, 2, 0, 1, 1, 1],
    ['CSG-958', 'Casing 9-5/8" 40# L80', 'material', 'joint', 980, 60, 45, 40, 80, 0, 20, 1, 1],
    ['TBG-278', 'Tubing 2-7/8" 6.5# N80', 'material', 'joint', 210, 300, 30, 100, 200, 0, 50, 1, 1],
    ['DSL', 'Diesel Fuel', 'supply', 'liter', 1.1, 42000, 3, 15000, 30000, 5000, 5000, 1, 0],
    ['LUB-15W40', 'Engine Oil 15W-40', 'supply', 'liter', 4.2, 800, 5, 300, 600, 100, 200, 1, 0],
    ['BRINE', 'Completion Brine 9.5 ppg', 'material', 'bbl', 28, 150, 7, 100, 300, 0, 50, 0, 0],
    ['PKR-7', 'Production Packer 7"', 'material', 'ea', 4200, 3, 28, 2, 2, 0, 1, 1, 1],
    ['PMP-LNR', 'Pump Liner 6-1/2"', 'spare part', 'ea', 640, 8, 21, 6, 12, 2, 3, 2, 1],
    ['PMP-PST', 'Pump Piston Assembly', 'spare part', 'ea', 180, 14, 14, 10, 20, 4, 5, 2, 0],
    ['PMP-VS', 'Valve & Seat Set', 'spare part', 'set', 320, 9, 14, 10, 20, 4, 5, 2, 1],
    ['IRON-1502', 'Hammer Union 2" Fig 1502', 'spare part', 'ea', 150, 25, 10, 10, 20, 0, 5, 2, 0],
    ['HOSE-HP', 'High Pressure Hose 2" x 10 ft', 'tool', 'ea', 890, 6, 21, 4, 4, 0, 2, 2, 1],
    ['BOP-RAM', 'BOP Ram Rubber 5"', 'spare part', 'ea', 760, 4, 35, 4, 6, 2, 2, 1, 1],
    ['PPE-CVR', 'FR Coveralls', 'supply', 'ea', 65, 70, 7, 40, 60, 10, 20, 3, 0],
    ['H2S-DET', 'Personal H2S Detector', 'tool', 'ea', 290, 18, 14, 15, 10, 5, 5, 3, 1],
  ].map(([code, name, category, uom, unit_cost, on_hand, lead_time_days, reorder_level, reorder_qty, safety_stock, min_order_qty, s, qa]) =>
    ({ code, name, category, uom, unit_cost, on_hand, lead_time_days, reorder_level, reorder_qty, safety_stock, min_order_qty, preferred_supplier_id: sup[s].id, qa_required: !!qa, location: `A-${code.slice(0, 3)}` })));
  const iid = code => items.find(i => i.code === code).id;
  await ins('approval_rules', [{ seq: 1, min_amount: 0, role: 'procurement_manager' }, { seq: 2, min_amount: 25000, role: 'finance_manager' }, { seq: 3, min_amount: 100000, role: 'finance_controller' }]);

  // ---- Planning templates (routing, bill of materials, crew, KPIs) per operation ----
  const act = (operation, rows) => rows.map(([name, base_hours, hours_per_1000ft], i) => ({ operation, seq: (i + 1) * 10, name, base_hours, hours_per_1000ft }));
  await ins('activity_templates', [
    ...act('drilling', [['Mobilisation & rig-up', 48, 0], ['Spud & drill surface hole', 12, 3], ['Run & cement surface casing', 18, 1], ['Nipple up & pressure test BOP', 12, 0],
      ['Drill production hole', 10, 14], ['Wireline logging', 8, 1], ['Run & cement production casing', 16, 2], ['Rig-down & demobilisation', 36, 0]]),
    ...act('workover', [['Mobilisation & rig-up', 16, 0], ['Kill well & nipple up BOP', 10, 0], ['Pull tubing & completion', 6, 2], ['Clean-out & repair', 12, 1.5], ['Run completion & packer', 8, 2], ['Pressure test & hand-over', 6, 0], ['Rig-down', 12, 0]]),
    ...act('surface pumping', [['Mobilise & spot equipment', 8, 0], ['Rig-up treating lines', 6, 0], ['Pressure test lines', 3, 0], ['Pumping operation', 12, 2], ['Flush & rig-down', 6, 0]]),
  ]);
  const mat = (operation, rows) => rows.map(([code, base_qty, qty_per_1000ft]) => ({ operation, item_id: iid(code), base_qty, qty_per_1000ft }));
  await ins('material_templates', [
    ...mat('drilling', [['MUD-BEN', 100, 60], ['MUD-BAR', 50, 40], ['CMT-G', 80, 35], ['BIT-PDC85', 1, 0.15], ['CSG-958', 0, 9], ['DSL', 4000, 2500], ['LUB-15W40', 100, 20], ['BOP-RAM', 2, 0], ['PPE-CVR', 20, 0], ['H2S-DET', 20, 0]]),
    ...mat('workover', [['BRINE', 60, 20], ['TBG-278', 0, 32], ['PKR-7', 1, 0], ['DSL', 1500, 400], ['LUB-15W40', 40, 5], ['PPE-CVR', 8, 0], ['H2S-DET', 8, 0]]),
    ...mat('surface pumping', [['PMP-LNR', 3, 0], ['PMP-PST', 3, 0], ['PMP-VS', 3, 0], ['IRON-1502', 8, 0], ['HOSE-HP', 2, 0], ['DSL', 1200, 200], ['PPE-CVR', 6, 0]]),
  ]);
  const crewT = (operation, rows) => rows.map(([position, qty]) => ({ operation, position, qty }));
  await ins('crew_templates', [
    ...crewT('drilling', [['Toolpusher', 1], ['Driller', 2], ['Assistant Driller', 2], ['Derrickman', 2], ['Floorman', 4], ['Roustabout', 2], ['Mechanic', 1], ['Electrician', 1], ['HSE Officer', 1]]),
    ...crewT('workover', [['Rig Supervisor', 1], ['Driller', 1], ['Derrickman', 1], ['Floorman', 2], ['Mechanic', 1], ['HSE Officer', 1]]),
    ...crewT('surface pumping', [['Pump Supervisor', 1], ['Pump Operator', 3], ['Mechanic', 1], ['HSE Officer', 1]]),
  ]);
  const kp = (operation, rows) => rows.map(([name, target, unit, direction, auto_key]) => ({ operation, name, target, unit, direction, auto_key }));
  await ins('kpi_templates', [
    ...kp('drilling', [['Non-productive time', 5, '%', 'at most', 'npt_pct'], ['Rate of penetration', 45, 'ft/hr', 'at least', 'rop'], ['Schedule variance', -5, '% pts', 'at least', 'schedule_var_pct'], ['Cost variance vs earned value', 10, '%', 'at most', 'cost_var_pct'], ['Recordable incidents', 0, 'count', 'at most', 'incidents']]),
    ...kp('workover', [['Non-productive time', 8, '%', 'at most', 'npt_pct'], ['Schedule variance', -5, '% pts', 'at least', 'schedule_var_pct'], ['Cost variance vs earned value', 10, '%', 'at most', 'cost_var_pct'], ['Recordable incidents', 0, 'count', 'at most', 'incidents']]),
    ...kp('surface pumping', [['Pump uptime', 97, '%', 'at least', ''], ['Non-productive time', 3, '%', 'at most', 'npt_pct'], ['Cost variance vs earned value', 10, '%', 'at most', 'cost_var_pct'], ['Recordable incidents', 0, 'count', 'at most', 'incidents']]),
  ]);

  // ---- Sales ----
  const cust = await ins('customers', [['Northfield Petroleum', 'Ana Villar'], ['Sierra Basin Energy', 'Tom Ibarra'], ['Coral Shelf Resources', 'May Lim']].map(([name, contact_person]) => ({ name, contact_person, email: `ops@${name.split(' ')[0].toLowerCase()}.test` })));
  const wells = await ins('wells', [['NF-12', 'Northfield', 0, 'oil', 6200, 'drilling'], ['NF-07', 'Northfield', 0, 'oil', 7400, 'producing'], ['SB-03', 'Sierra Basin', 1, 'gas', 10500, 'planned'], ['CS-21', 'Coral Shelf', 2, 'water injection', 5200, 'producing']]
    .map(([name, fld, c, well_type, depth_ft, status]) => ({ name, field: fld, customer_id: cust[c].id, well_type, depth_ft, status, location: `${fld} block` })));
  const so = (i, c, w, operation, api_code, depth, flow, start, amount, status) => ({ so_no: `SO-000${i}`, customer_id: cust[c].id, well_id: wells[w].id, operation, api_code, target_depth_ft: depth, target_flow_gpm: flow, requested_start: D(start), amount, status, sales_person: 'Sales Executive' });
  await ins('sales_orders', [so(1, 0, 0, 'drilling', '4F, 7K', 6200, 650, -5, 640000, 'confirmed'), so(2, 1, 2, 'drilling', '4F, 16A', 10500, 850, 21, 1150000, 'confirmed'),
    so(3, 0, 1, 'workover', '4F', 7400, 250, 24, 190000, 'confirmed'), so(4, 2, 3, 'surface pumping', '674', 5200, 420, 6, 85000, 'quotation')]);

  // ---- Live project: plan SO-0001 through MPS -> MRP -> approve -> firm, then a week of work tickets ----
  await generateMps();
  const firstLine = (await db.list('mps_lines')).sort((a, b) => a.start_date.localeCompare(b.start_date))[0];
  await db.update('mps_lines', firstLine.id, { status: 'firmed' });
  const run = await runMrp(admin);
  await approveMrp(run.id, admin);
  await firmMrp(run.id, admin);
  const project = (await db.list('projects'))[0];
  const acts = (await db.list('project_activities', { project_id: project.id })).sort((a, b) => a.seq - b.seq);
  const manning = (await db.list('project_manning', { project_id: project.id })).filter(m => m.employee_id);
  // One driller arrives with 11 straight days from a previous job, so the 15-day limit trips during this week.
  const veteran = manning.find(m => m.position === 'Driller').employee_id;
  await ins('timesheets', Array.from({ length: 11 }, (_, i) => ({ employee_id: veteran, work_date: D(-16 + i), regular_hours: 8, ot_hours: 4, source: 'manual', status: 'consolidated' })));
  const day = (offset, lines, extra = {}) => saveTicket({ project_id: project.id, work_date: D(offset), shift: 'day', status: 'submitted', entry_mode: offset === -2 ? 'offline' : 'online', client_id: `seed-${offset}`,
    lines, crew: manning.map(m => ({ employee_id: m.employee_id, hours: 12 })), materials: [{ item_id: iid('DSL'), qty: 2600 }, ...(extra.materials || [])], incidents: 0, remarks: extra.remarks || '' }, admin);
  const L = (i, hours, pct, description, o = {}) => ({ activity_id: acts[i].id, description, hours, pct_complete: pct, ...o });
  await day(-5, [L(0, 24, 50, 'Convoy arrival, spot substructure, raise mast')]);
  await day(-4, [L(0, 24, 100, 'Rig-up complete, acceptance checklist signed')]);
  await day(-3, [L(1, 22, 70, 'Spud well, drill 17-1/2" surface hole', { depth_from: 0, depth_to: 780 }), L(1, 2, 70, 'Shaker screen change-out', { npt: true })], { materials: [{ item_id: iid('MUD-BEN'), qty: 180 }] });
  await day(-2, [L(1, 10, 100, 'Drill to surface casing point', { depth_from: 780, depth_to: 1200 }), L(2, 14, 40, 'Run 13-3/8" casing')], { materials: [{ item_id: iid('MUD-BEN'), qty: 90 }], remarks: 'Entered offline at rig site, synced at shift end.' });
  await day(-1, [L(2, 18, 85, 'Cement surface casing, wait on cement'), L(2, 6, 85, 'Cement unit breakdown - waiting on spare', { npt: true })], { materials: [{ item_id: iid('CMT-G'), qty: 150 }] });
  await db.update('wells', wells[0].id, { status: 'drilling' });
  await ins('invoices', [{ invoice_no: 'INV-0001', customer_id: cust[0].id, project_id: project.id, invoice_date: D(-4), due_date: D(26), amount: 128000, status: 'posted' }]);
  console.log('[seed] Done.');
  return true;
}
