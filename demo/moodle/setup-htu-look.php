<?php
// Makes the local Moodle look and feel like HTU eLearning (elearning.htu.edu.jo),
// matched from screenshots of the student side. HTU runs the paid "Lambda"
// theme; this approximates it on core Classic + custom SCSS instead of copying
// Lambda's code. Also recreates the course structure (titles only, placeholder
// text) of two HTU courses, with the Rennix LTI tools added to each.
//
// Idempotent. Run inside the container:  php /tmp/setup-htu-look.php
// Expects the assets copied to /tmp/htu-assets/ (logo, favicon, background).

define('CLI_SCRIPT', true);
require('/var/www/html/config.php');
require_once($CFG->dirroot . '/course/lib.php');
require_once($CFG->dirroot . '/course/modlib.php');
require_once($CFG->libdir . '/enrollib.php');

\core\session\manager::set_user(get_admin());
$syscontext = context_system::instance();
$assets = '/tmp/htu-assets';

// ---------------------------------------------------------------- look
function store_setting_file($component, $filearea, $name, $path, $plugin) {
    global $syscontext;
    $fs = get_file_storage();
    $fs->delete_area_files($syscontext->id, $component, $filearea);
    $fs->create_file_from_pathname([
        'contextid' => $syscontext->id, 'component' => $component, 'filearea' => $filearea,
        'itemid' => 0, 'filepath' => '/', 'filename' => $name,
    ], $path);
    set_config($filearea, '/' . $name, $plugin);
}
// HTU's logo and campus photo are HTU's own images and are not in the repo;
// drop them into moodle/assets/ locally (see README) and they're picked up.
if (file_exists("$assets/htu-logo.png")) {
    store_setting_file('core_admin', 'logo', 'htu-logo.png', "$assets/htu-logo.png", 'core_admin');
    store_setting_file('core_admin', 'logocompact', 'htu-logo.png', "$assets/htu-logo.png", 'core_admin');
}
if (file_exists("$assets/htu-favicon.png")) {
    store_setting_file('core_admin', 'favicon', 'htu-favicon.png', "$assets/htu-favicon.png", 'core_admin');
}
if (file_exists("$assets/htu-background.png")) {
    store_setting_file('theme_classic', 'backgroundimage', 'htu-background.png', "$assets/htu-background.png", 'theme_classic');
    store_setting_file('theme_classic', 'loginbackgroundimage', 'htu-background.png', "$assets/htu-background.png", 'theme_classic');
}

set_config('theme', 'classic');
set_config('brandcolor', '#FF141D', 'theme_classic');
set_config('navbardark', 0, 'theme_classic');
set_config('scss', file_get_contents("$assets/htu.scss"), 'theme_classic');
set_config('custommenuitems', "Dashboard|/my/\nMy courses|/my/courses.php");
set_config('additionalhtmlfooter', file_get_contents("$assets/htu-footer.html"));
set_config('displaycategories', 1, 'block_myoverview');   // "School of ..." under each course card
set_config('frontpageloggedin', '');                       // HTU sends people to My courses, not a front page
set_config('defaulthomepage', 3);                          // HOMEPAGE_MYCOURSES
set_config('tilecolour1', '#1670CC', 'format_tiles');      // HTU tiles' blue top edge

// HTU has "Administration" on the right and no Navigation block; the (CSS-hidden)
// Navigation block is parked on the right too so no empty left column is reserved.
foreach (['settings', 'navigation'] as $blockname) {
    foreach ($DB->get_records('block_instances', ['blockname' => $blockname]) as $b) {
        $b->defaultregion = 'side-post';
        $DB->update_record('block_instances', $b);
    }
    $DB->execute("UPDATE {block_positions} SET region = 'side-post'
                   WHERE blockinstanceid IN (SELECT id FROM {block_instances} WHERE blockname = ?)", [$blockname]);
}

// ---------------------------------------------------------------- courses
$teacher = $DB->get_record('user', ['username' => 'teacher1'], '*', MUST_EXIST);
$student = $DB->get_record('user', ['username' => 'student1'], '*', MUST_EXIST);
$roles = [
    'teacher' => $DB->get_field('role', 'id', ['shortname' => 'editingteacher']),
    'student' => $DB->get_field('role', 'id', ['shortname' => 'student']),
];

$category = $DB->get_record('course_categories', ['name' => 'School of Computer and Informatics']);
if (!$category) {
    $category = core_course_category::create(['name' => 'School of Computer and Informatics'])->get_db_record();
}

// The earlier plain test course: keep it (its LTI links still work) but take
// the test users out so "My courses" shows just the HTU-style courses.
if ($old = $DB->get_record('course', ['shortname' => 'RNX101'])) {
    $manual = enrol_get_plugin('manual');
    if ($inst = $DB->get_record('enrol', ['courseid' => $old->id, 'enrol' => 'manual'])) {
        $manual->unenrol_user($inst, $teacher->id);
        $manual->unenrol_user($inst, $student->id);
    }
}

$modules = [];
foreach (['page', 'label', 'forum', 'lti'] as $m) {
    $modules[$m] = $DB->get_field('modules', 'id', ['name' => $m], MUST_EXIST);
}

function add_mod($course, $section, $modname, array $fields) {
    global $modules;
    $info = (object)array_merge([
        'modulename' => $modname, 'module' => $modules[$modname], 'course' => $course->id,
        'section' => $section, 'visible' => 1,
        'introeditor' => ['text' => '', 'format' => FORMAT_HTML, 'itemid' => 0],
    ], $fields);
    return create_module($info);
}
function add_label($course, $section, $html) {
    return add_mod($course, $section, 'label', [
        'introeditor' => ['text' => $html, 'format' => FORMAT_HTML, 'itemid' => 0],
    ]);
}
function add_page($course, $section, $name, $html) {
    return add_mod($course, $section, 'page', [
        'name' => $name, 'content' => $html, 'contentformat' => FORMAT_HTML,
        'display' => 5, 'printintro' => 0, 'printlastmodified' => 0,
    ]);
}
$heading = fn($emoji, $text) => "<h4 class=\"htu-section-heading\">$emoji $text</h4>";
$placeholder = '<p><em>Placeholder content for the local test copy.</em></p>';

function make_course($shortname, $fullname, array $sectionnames, $category) {
    global $DB;
    if ($c = $DB->get_record('course', ['shortname' => $shortname])) {
        return [$c, false];
    }
    $c = create_course((object)[
        'fullname' => $fullname, 'shortname' => $shortname, 'category' => $category->id,
        'format' => 'tiles', 'numsections' => count($sectionnames), 'visible' => 1,
        'enablecompletion' => 1, 'showcompletionconditions' => 1,
        'defaulttileicon' => 'bookmark-o', 'basecolour' => '#1670CC',
        'courseshowtileprogress' => 0, 'courseusebarforheadings' => 0,
        'summary' => '', 'summaryformat' => FORMAT_HTML,
    ]);
    foreach ($sectionnames as $i => $name) {
        $section = $DB->get_record('course_sections', ['course' => $c->id, 'section' => $i + 1], '*', MUST_EXIST);
        course_update_section($c, $section, ['name' => $name]);
    }
    return [$c, true];
}

function enrol_test_users($course) {
    global $DB, $teacher, $student, $roles;
    $manual = enrol_get_plugin('manual');
    $inst = $DB->get_record('enrol', ['courseid' => $course->id, 'enrol' => 'manual'], '*', MUST_EXIST);
    $manual->enrol_user($inst, $teacher->id, $roles['teacher']);
    $manual->enrol_user($inst, $student->id, $roles['student']);
}

// The Tutor Bot "video panel": a Tutor Bot launch with custom parameter
// rennix_view=chat, available but not shown on the course page ("stealth").
// local_rennixtutorbot frames it next to each lecture video.
function add_video_panel_tool($course) {
    global $DB;
    set_config('allowstealth', 1);
    $type = $DB->get_record('lti_types', ['name' => 'Rennix Tutor Bot'], '*', MUST_EXIST);
    if ($DB->record_exists_select('lti', 'course = ? AND typeid = ? AND ' .
            $DB->sql_like('instructorcustomparameters', '?'), [$course->id, $type->id, '%rennix_view=chat%'])) {
        return;
    }
    add_mod($course, 0, 'lti', [
        'name' => 'Rennix Tutor Bot (video panel)', 'typeid' => $type->id, 'toolurl' => '',
        'instructorcustomparameters' => 'rennix_view=chat',
        'instructorchoicesendname' => 1, 'instructorchoicesendemailaddr' => 1,
        'instructorchoiceacceptgrades' => 0, 'grade' => 0, 'launchcontainer' => 3,
        'visible' => 1, 'visibleoncoursepage' => 0,
    ]);
}

function add_rennix_tools($course, $section) {
    global $DB;
    add_video_panel_tool($course);
    foreach (['Rennix Tutor Bot', 'Rennix Analytics'] as $name) {
        $type = $DB->get_record('lti_types', ['name' => $name], '*', MUST_EXIST);
        add_mod($course, $section, 'lti', [
            'name' => $name, 'typeid' => $type->id, 'toolurl' => '',
            'instructorchoicesendname' => 1, 'instructorchoicesendemailaddr' => 1,
            'instructorchoiceacceptgrades' => $name === 'Rennix Tutor Bot' ? 1 : 0,
            'grade' => $name === 'Rennix Tutor Bot' ? 100 : 0, 'launchcontainer' => 4,
        ]);
    }
}

// ---- Programming-Summer/26 (All Section): same tile titles as HTU's course
[$prog, $created] = make_course('PROG-SUM26', 'Programming-Summer/26 (All Section)', [
    '1 - Introduction',
    '2 - Environment Setup + Getting Started with Java',
    '3 - Operators, Variables and Coding Standards',
    '4 - Integrated Development Environments',
    '5 - Conditionals',
    '6 - Repetition and Arrays',
    '7 - Algorithms and problem Solving',
    '8- Procedural Programming Paradigm',
    '9 - Object Oriented Programming Paradigm (OOP) part 1',
    '10 - Object Oriented Programming Paradigm (OOP) part 2',
    '11 - Object Oriented Programming Paradigm (OOP) part 3',
    '12 - Object Oriented Programming Paradigm (OOP) part 4',
    '13 - Debugging, Errors and Exception Handling',
    '14- Event-Driven Paradigm',
    'Final Assignment ⛳',
    'Assignment Brief Submission 2022',
    'Resubmission RQF 2022',
], $category);
enrol_test_users($prog);
if ($created) {
    // Section 0: the course-info area above the tiles.
    add_page($prog, 0, 'Rules and Regulations', $placeholder);
    add_label($prog, 0,
        '<h2>Course Guidelines</h2>' . $placeholder .
        '<h2>Attendance Policy</h2>' . $placeholder .
        '<h2>Academic Integrity</h2>' . $placeholder .
        '<h2>Lab Rules</h2>' . $placeholder);
    add_mod($prog, 0, 'forum', ['name' => 'Announcements', 'type' => 'news', 'forcesubscribe' => 1]);
    add_rennix_tools($prog, 0);

    // Every module tile gets HTU's Material / Activities / Videos layout.
    for ($s = 1; $s <= 14; $s++) {
        add_label($prog, $s, $heading('📚', 'Material'));
        if ($s === 6) {
            add_label($prog, $s, '<p><strong>Loops</strong></p>');
            add_page($prog, $s, 'JAVA Loops', $placeholder);
            add_label($prog, $s, '<p><strong>Arrays</strong></p>');
            add_page($prog, $s, 'JAVA Arrays', $placeholder);
        }
        add_label($prog, $s, $heading('🧩', 'Activities'));
        add_label($prog, $s, $heading('📹', 'Videos'));
        if ($s === 6) {
            foreach (['Introduction to Loops | Video', 'Mastering the For Loop | Video',
                      'For Loop- Practical Examples | Video', 'Tracing Memory with For Loops | Video'] as $v) {
                // One real Vimeo embed (Blender's CC-licensed "Big Buck Bunny") to demo
                // the Tutor Bot side panel, knowledge check and video-position tracking.
                add_page($prog, $s, $v, $v === 'For Loop- Practical Examples | Video'
                    ? '<p>Watch the video, then ask the Tutor Bot about any moment.</p>' .
                      '<div style="position:relative;padding-top:56.25%"><iframe src="https://player.vimeo.com/video/1084537" ' .
                      'style="position:absolute;inset:0;width:100%;height:100%" frameborder="0" ' .
                      'allow="autoplay; fullscreen; picture-in-picture" allowfullscreen title="Lecture video"></iframe></div>'
                    : $placeholder);
            }
        }
    }
}

// ---- Apprenticeship for DS & AI 1-1-0-Summer/26 (structure not visible in the screenshots: generic weeks)
[$appr, $created] = make_course('APPR-DSAI-SUM26', 'Apprenticeship for DS & AI 1-1-0-Summer/26',
    ['1 - Week 1', '2 - Week 2', '3 - Week 3', '4 - Week 4'], $category);
enrol_test_users($appr);
if ($created) {
    add_mod($appr, 0, 'forum', ['name' => 'Announcements', 'type' => 'news', 'forcesubscribe' => 1]);
    add_rennix_tools($appr, 0);
    for ($s = 1; $s <= 4; $s++) {
        add_label($appr, $s, $heading('📚', 'Material'));
        add_label($appr, $s, $heading('🧩', 'Activities'));
    }
}

theme_reset_all_caches();
purge_caches();
echo json_encode(['programming' => (int)$prog->id, 'apprenticeship' => (int)$appr->id]), PHP_EOL;
