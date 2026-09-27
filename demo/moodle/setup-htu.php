<?php
// One-shot (idempotent) setup of the local test Moodle to mirror how HTU's
// eLearning site is wired to Rennix: HTU branding, a teacher + student, a test
// course, and Rennix Tutor Bot + Rennix Analytics registered as LTI 1.3
// External Tools (via mod_lti's own lti_add_type(), like on HTU's real Moodle)
// and placed as activities in the course.
//
// Run inside the container:  php /tmp/setup-htu.php
// Passwords come from env (TEACHER_PASSWORD / STUDENT_PASSWORD), never printed.
// Prints one JSON line with the per-tool client_id / deployment_id that
// rennix-lti needs.

define('CLI_SCRIPT', true);
require('/var/www/html/config.php');
require_once($CFG->dirroot . '/user/lib.php');
require_once($CFG->dirroot . '/course/lib.php');
require_once($CFG->dirroot . '/course/modlib.php');
require_once($CFG->dirroot . '/mod/lti/locallib.php');
require_once($CFG->libdir . '/enrollib.php');

\core\session\manager::set_user(get_admin());

$toolhost = 'http://localhost:3002';            // what the browser uses
$toolhostserver = 'http://host.docker.internal:3002'; // what Moodle's server uses

// ---- Site identity + HTU look (Boost recoloured; HTU's Lambda theme is paid) ----
$site = get_site();
$DB->update_record('course', (object)[
    'id' => $site->id,
    'fullname' => 'HTU eLearning (local test)',
    'shortname' => 'HTU eLearning',
]);
set_config('theme', 'boost');
set_config('brandcolor', '#FF141D', 'theme_boost');
set_config('scss', '$primary: #FF141D; $info: #0070a8; .navbar.fixed-top { border-bottom: 3px solid #FF141D; }', 'theme_boost');
// Local dev only: let Moodle's server side reach the tool on the host.
set_config('curlsecurityblockedhosts', '');
set_config('curlsecurityallowedport', '');

// ---- Users ----
function ensure_user($username, $first, $last, $email, $password) {
    global $DB, $CFG;
    if ($u = $DB->get_record('user', ['username' => $username, 'deleted' => 0])) {
        return $u;
    }
    $id = user_create_user((object)[
        'username' => $username, 'password' => $password, 'firstname' => $first, 'lastname' => $last,
        'email' => $email, 'auth' => 'manual', 'confirmed' => 1, 'mnethostid' => $CFG->mnet_localhost_id,
    ], true, false);
    return $DB->get_record('user', ['id' => $id]);
}
$teacher = ensure_user('teacher1', 'Test', 'Teacher', 'teacher1@htu.local.test', getenv('TEACHER_PASSWORD'));
$student = ensure_user('student1', 'Test', 'Student', 'student1@htu.local.test', getenv('STUDENT_PASSWORD'));

// ---- Course ----
$course = $DB->get_record('course', ['shortname' => 'RNX101']);
if (!$course) {
    $course = create_course((object)[
        'fullname' => 'RNX101 - Rennix Test Course', 'shortname' => 'RNX101',
        'category' => $DB->get_field_sql('SELECT MIN(id) FROM {course_categories}'),
        'format' => 'topics', 'numsections' => 3, 'visible' => 1,
    ]);
}
$manual = enrol_get_plugin('manual');
$instance = $DB->get_record('enrol', ['courseid' => $course->id, 'enrol' => 'manual']);
$manual->enrol_user($instance, $teacher->id, $DB->get_field('role', 'id', ['shortname' => 'editingteacher']));
$manual->enrol_user($instance, $student->id, $DB->get_field('role', 'id', ['shortname' => 'student']));

// ---- LTI 1.3 External Tools (site-level, like an admin-configured preconfigured tool) ----
function ensure_tool($name, $description) {
    global $DB, $toolhost, $toolhostserver;
    if ($t = $DB->get_record('lti_types', ['name' => $name])) {
        return $t;
    }
    $type = (object)['state' => LTI_TOOL_STATE_CONFIGURED];
    $config = (object)[
        'lti_typename' => $name,
        'lti_description' => $description,
        'lti_toolurl' => "$toolhost/lti/launch",
        'lti_ltiversion' => LTI_VERSION_1P3,
        'lti_keytype' => LTI_JWK_KEYSET,
        'lti_publickeyset' => "$toolhostserver/lti/jwks",
        'lti_initiatelogin' => "$toolhost/lti/login",
        'lti_redirectionuris' => "$toolhost/lti/launch",
        'lti_coursevisible' => LTI_COURSEVISIBLE_ACTIVITYCHOOSER,
        'lti_launchcontainer' => LTI_LAUNCH_CONTAINER_WINDOW,
        'lti_contentitem' => 1,
        'lti_toolurl_ContentItemSelectionRequest' => "$toolhost/lti/launch",
        'lti_sendname' => LTI_SETTING_ALWAYS,
        'lti_sendemailaddr' => LTI_SETTING_ALWAYS,
        'lti_acceptgrades' => LTI_SETTING_DELEGATE,
        'lti_forcessl' => 0,
        'ltiservice_gradesynchronization' => 2,  // AGS: use this service for grade sync and column management
        'ltiservice_memberships' => 1,           // NRPS: roster
    ];
    $id = lti_add_type($type, $config);
    return $DB->get_record('lti_types', ['id' => $id]);
}
$tools = [
    'tutor_bot' => ensure_tool('Rennix Tutor Bot', 'AI tutor for students, content tools for instructors.'),
    'analytics' => ensure_tool('Rennix Analytics', 'Instructor-only course analytics.'),
];

// ---- Place each tool as an activity in section 1 of the course ----
$ltimodule = $DB->get_record('modules', ['name' => 'lti'], '*', MUST_EXIST);
foreach ($tools as $product => $tool) {
    if ($DB->record_exists('lti', ['course' => $course->id, 'typeid' => $tool->id])) {
        continue;
    }
    create_module((object)[
        'modulename' => 'lti', 'module' => $ltimodule->id, 'course' => $course->id, 'section' => 1,
        'visible' => 1, 'name' => $tool->name, 'typeid' => $tool->id, 'toolurl' => '',
        'instructorchoicesendname' => 1, 'instructorchoicesendemailaddr' => 1,
        'instructorchoiceacceptgrades' => $product === 'tutor_bot' ? 1 : 0,
        'grade' => $product === 'tutor_bot' ? 100 : 0,
        'launchcontainer' => LTI_LAUNCH_CONTAINER_WINDOW,
        'introeditor' => ['text' => '', 'format' => FORMAT_HTML, 'itemid' => 0],
    ]);
}

purge_caches();

$out = ['issuer' => $CFG->wwwroot, 'courseid' => (int)$course->id, 'tools' => []];
foreach ($tools as $product => $tool) {
    // Moodle uses the tool type id as the deployment_id.
    $out['tools'][$product] = ['clientId' => $tool->clientid, 'deploymentId' => (string)$tool->id];
}
echo json_encode($out), PHP_EOL;
