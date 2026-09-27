<?php
require(__DIR__ . '/../../config.php');
require_once(__DIR__ . '/classes/helper.php');

header('Content-Type: application/json');

$cmid = required_param('cmid', PARAM_INT);
$cm = get_coursemodule_from_id('', $cmid, 0, false, MUST_EXIST);
$course = get_course($cm->course);
require_login($course, false, $cm);
$context = context_course::instance($cm->course);
require_capability('local/rennixtutorbot:use', $context);

echo json_encode(local_rennixtutorbot_helper::get_popups($cmid));
