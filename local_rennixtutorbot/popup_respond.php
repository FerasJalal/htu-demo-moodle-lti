<?php
require(__DIR__ . '/../../config.php');
require_once(__DIR__ . '/classes/helper.php');

header('Content-Type: application/json');

try {
    $cmid = required_param('cmid', PARAM_INT);
    $popupid = required_param('popup_id', PARAM_INT);
    $status = optional_param('status', '', PARAM_ALPHA); // 'dropped', or blank for an answered response
    $selectedindex = optional_param('selected_index', -1, PARAM_INT);

    $cm = get_coursemodule_from_id('', $cmid, 0, false, MUST_EXIST);
    $course = get_course($cm->course);
    require_login($course, false, $cm);
    $context = context_course::instance($cm->course);
    require_capability('local/rennixtutorbot:use', $context);
    require_sesskey();

    global $USER;

    if ($status === 'dropped') {
        local_rennixtutorbot_helper::record_dropped($popupid, $USER->id);
        echo json_encode(['ok' => true]);
        exit;
    }

    $result = local_rennixtutorbot_helper::record_response($popupid, $USER->id, $selectedindex);
    if ($result === null) {
        echo json_encode(['error' => 'Unknown question.']);
        exit;
    }
    echo json_encode($result);
} catch (\Throwable $e) {
    echo json_encode(['error' => $e->getMessage()]);
}
