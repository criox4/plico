# Adds each target's PrivacyInfo.xcprivacy to its Copy Bundle Resources phase. Idempotent.
require 'xcodeproj'
project = Xcodeproj::Project.open(File.expand_path('../ios/App/App.xcodeproj', __dir__))
{ 'App' => 'App', 'ShareExtension' => 'ShareExtension', 'PlicoWidget' => 'PlicoWidget' }.each do |target_name, group_name|
  target = project.targets.find { |t| t.name == target_name } or next
  group = project.main_group[group_name]
  ref = group.files.find { |f| f.path == 'PrivacyInfo.xcprivacy' } || group.new_file('PrivacyInfo.xcprivacy')
  target.resources_build_phase.add_file_reference(ref, true)
  puts "#{target_name}: PrivacyInfo.xcprivacy in resources"
end
project.save
